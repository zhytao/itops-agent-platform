/**
 * cmdbSyncWriter — iTop CI → 平台表的数据写入层
 *
 * 为什么不直接用 dcRepository/serverRepository？
 *   现有 repository 的 create 方法是给「平台原生 CRUD」设计的，字段集与 iTop 同步所需的
 *   （如 servers.ip_address / network_devices 的最小字段集）不完全匹配。
 *   强行复用会导致字段错配或需要给 repo 加大量「仅为同步用」的方法，反而增加耦合。
 *
 *   因此本文件作为 cmdb-sync 模块专属的数据写入层（类似 modules/dc 里的 writer 模式），
 *   把裸 SQL 收敛到这里，让 itopSyncService.ts 只负责编排（取数 → 映射 → 写入 → 记日志）。
 *
 * 所有写入都接受一个外部传入的 db 事务上下文（better-sqlite3 Transaction），
 * 由 itopSyncService 决定事务边界，保证「数据写入 + idMap 更新」原子性。
 */

/* eslint-disable no-restricted-imports -- cmdb-sync 专属写入层：需要直接执行同步专用 SQL
   （servers/network_devices 的现有 repo create 方法字段集与 iTop 同步需求不匹配，
    强行复用会导致字段错配。详见本文件头注释）*/
import db from '../../../models/database';
import { roomsRepo, racksRepo, pdusRepo } from '../../../repositories';
import type { DcRackCreateInput } from '../../../repositories/dcRepository/types';

// ============================================================
// Location → dc_rooms
// ============================================================

export function upsertRoom(
  existingId: string | undefined,
  fields: { name: string; description?: string },
): string {
  if (existingId) {
    // roomsRepo.update 要求完整 DcRoomUpdateInput，这里只同步 name/description
    db.prepare(`
      UPDATE dc_rooms SET name = ?, description = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.description ?? '', existingId);
    return existingId;
  }
  const newId = crypto.randomUUID();
  roomsRepo.create({
    id: newId,
    name: fields.name,
    description: fields.description ?? '',
  });
  return newId;
}

// ============================================================
// Rack → dc_racks
// ============================================================

/**
 * @returns { id, action } 新建或更新的平台 ID；若缺少 room_id 则 throw 以触发 skip
 */
export function upsertRack(
  existingId: string | undefined,
  fields: { name: string; nb_u?: number; location_name?: string },
  roomId: string | null,
): { id: string; action: 'create' | 'update' } {
  // dc_racks.room_id 是 NOT NULL（见 v028_dc_infrastructure），缺机房时不能写入
  if (!roomId) {
    throw new Error(
      `机柜 ${fields.name} 无法关联到机房（location_name="${fields.location_name ?? ''}" 未同步或为空），跳过`,
    );
  }

  if (existingId) {
    // 只更新 name / total_u / room_id（COALESCE 保留原值）
    db.prepare(`
      UPDATE dc_racks SET name = ?, total_u = ?, room_id = COALESCE(?, room_id), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.nb_u ?? 42, roomId, existingId);
    return { id: existingId, action: 'update' };
  }

  const newId = crypto.randomUUID();
  const input: DcRackCreateInput = {
    id: newId,
    name: fields.name,
    room_id: roomId,
    total_u: fields.nb_u ?? 42,
  };
  racksRepo.create(input);
  return { id: newId, action: 'create' };
}

// ============================================================
// Server → servers
// ============================================================

export interface ServerUpsertResult {
  id: string;
  action: 'create' | 'update' | 'skip';
  message?: string;
}

/**
 * 注意：servers.ip_address 在 v001 schema 中并无 UNIQUE 约束
 * （只有 network_devices.ip_address 和 credentials 表的 ip_address 是 UNIQUE）。
 * 因此这里不再做 IP 冲突预检——直接写入即可。
 *
 * iTop 字段映射：
 *   managementip_name → ip_address（管理 IP，优先）
 *   svrbizip_name     → 备用（业务 IP，managementip 为空时用）
 *   osfamily_name     → os
 */
export function upsertServer(
  existingId: string | undefined,
  fields: {
    name: string;
    managementip_name?: string;
    svrbizip_name?: string;
    osfamily_name?: string;
  },
  placement: RackPlacement | null,
): ServerUpsertResult {
  const ip = fields.managementip_name || fields.svrbizip_name || '';

  if (existingId) {
    db.prepare(`
      UPDATE servers
      SET name = ?, os = ?, hostname = COALESCE(NULLIF(?, ''), hostname), ip_address = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.osfamily_name ?? '', ip, ip || null, existingId);
    if (placement) upsertRackSlot(existingId, 'server', placement);
    return { id: existingId, action: 'update' };
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO servers (id, name, hostname, port, username, password, use_ssh_key, os, os_type, ip_address, enabled, tags, created_at, updated_at)
    VALUES (?, ?, ?, 22, '', NULL, 0, ?, 'linux', ?, 1, '[]', datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip || fields.name, fields.osfamily_name ?? '', ip || null);

  if (placement) upsertRackSlot(newId, 'server', placement);

  return {
    id: newId,
    action: 'create',
    message: '未同步 SSH 密码/密钥，请在平台手动配置',
  };
}

// ============================================================
// DatacenterDevice → network_devices / dc_pdus
// ============================================================

export interface DeviceUpsertResult {
  id: string;
  action: 'create' | 'update' | 'skip';
  table: 'network_devices' | 'dc_pdus';
  message?: string;
}

/**
 * 根据 finalclass 分流：
 *   pdu / ups 类 → dc_pdus
 *   其他（switch / router / firewall 等）→ network_devices（要求唯一 IP）
 *
 * iTop 字段映射：
 *   managementip_name → ip_address（管理 IP）
 *   finalclass        → 设备类型判断（NetworkDevice / PDU / UPS ...）
 */
export function upsertDatacenterDevice(
  existingId: string | undefined,
  fields: {
    name: string;
    description?: string;
    managementip_name?: string;
    finalclass?: string;
  },
  rack: {
    platformRackId: string | null; // 机柜关联（PDU 用 dc_pdus.rack_id 承载）
    placement: RackPlacement | null; // 完整 U 位（有则写 dc_rack_slots）
  },
): DeviceUpsertResult {
  const ip = fields.managementip_name || '';
  const finalClass = (fields.finalclass ?? '').toLowerCase();
  const isPDU = finalClass.includes('pdu') || finalClass.includes('ups');
  // slot 的 device_type 需区分 pdu/ups（listWithDeviceInfo 的 JOIN 条件按这两个值匹配）
  const slotDeviceType = finalClass.includes('ups') ? ('ups' as const) : ('pdu' as const);

  if (isPDU) {
    if (existingId) {
      db.prepare(`
        UPDATE dc_pdus SET name = ?, rack_id = COALESCE(?, rack_id), updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(fields.name, rack.platformRackId, existingId);
      if (rack.placement) upsertRackSlot(existingId, slotDeviceType, rack.placement);
      return { id: existingId, action: 'update', table: 'dc_pdus' };
    }
    const newId = crypto.randomUUID();
    pdusRepo.create({
      id: newId,
      name: fields.name,
      type: slotDeviceType,
      status: 'active',
      ip_address: ip,
      model: fields.description ?? '',
      rack_id: rack.platformRackId,
    });
    if (rack.placement) upsertRackSlot(newId, slotDeviceType, rack.placement);
    return { id: newId, action: 'create', table: 'dc_pdus' };
  }

  // network_devices 分支
  // network_devices.ip_address 是 NOT NULL UNIQUE（见 v006_network_device_credentials），
  // 无 IP 的设备必须跳过；IP 冲突时关联到已有记录。
  if (existingId) {
    db.prepare(`
      UPDATE network_devices SET name = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, existingId);
    if (rack.placement) upsertRackSlot(existingId, 'network_device', rack.placement);
    return { id: existingId, action: 'update', table: 'network_devices' };
  }

  if (!ip) {
    return {
      id: '',
      action: 'skip',
      table: 'network_devices',
      message: `${fields.name} 无 IP 地址，跳过（network_devices 要求唯一 IP）`,
    };
  }

  // IP 唯一性检查（仅 network_devices 需要）
  const ipOwner = db.prepare('SELECT id FROM network_devices WHERE ip_address = ?').get(ip) as
    | { id: string }
    | undefined;
  if (ipOwner) {
    return {
      id: ipOwner.id,
      action: 'skip',
      table: 'network_devices',
      message: `IP ${ip} 已存在，关联到已有设备`,
    };
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO network_devices (id, name, ip_address, vendor, device_type, status, snmp_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'unknown', 'unknown', 'online', 1, datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip);
  if (rack.placement) upsertRackSlot(newId, 'network_device', rack.placement);
  return { id: newId, action: 'create', table: 'network_devices' };
}

// ============================================================
// 辅助：按名称查机房（Rack 关联用）
// ============================================================

export function findRoomIdByName(name: string): string | null {
  const room = db.prepare('SELECT id FROM dc_rooms WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  return room?.id ?? null;
}

export function findRackIdByName(name: string): string | null {
  const rack = db.prepare('SELECT id FROM dc_racks WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  return rack?.id ?? null;
}

// ============================================================
// 机柜位置（设备在哪个机柜 + 起始 U + 高度）
// ============================================================

/** iTop 机柜位置字段（rack_id/nb_u/position_v 均为字符串或数字） */
export interface ITopRackPlacementFields {
  rack_id?: string | number;
  rack_name?: string;
  nb_u?: string | number;
  position_v?: string | number;
}

export interface RackPlacement {
  platformRackId: string;
  startU: number;
  endU: number;
}

/**
 * 解析 iTop 机柜 ID → 平台机柜 UUID
 * 优先用 cmdb_sync_state 里 Rack 的 idMap（准确），fallback 按 rack_name 查 dc_racks
 */
export function resolveRackId(
  fields: ITopRackPlacementFields,
  itopRackIdMap: Record<string, string>,
): string | null {
  if (fields.rack_id && itopRackIdMap[String(fields.rack_id)]) {
    return itopRackIdMap[String(fields.rack_id)];
  }
  if (fields.rack_name) {
    return findRackIdByName(fields.rack_name);
  }
  return null;
}

/**
 * 解析完整的机柜位置：机柜 + 起始 U + 高度。
 * iTop 语义：position_v = 设备起始 U（1-based，从下往上），nb_u = 设备高度。
 * 缺 U 位数据或机柜无法对应时返回 null（调用方跳过 U 位写入）。
 */
export function resolveRackPlacement(
  fields: ITopRackPlacementFields,
  itopRackIdMap: Record<string, string>,
): RackPlacement | null {
  const posV = Number(fields.position_v);
  if (!fields.position_v || !Number.isFinite(posV) || posV < 1) {
    return null;
  }
  const platformRackId = resolveRackId(fields, itopRackIdMap);
  if (!platformRackId) {
    return null;
  }
  const nbU = Number(fields.nb_u);
  const height = Number.isFinite(nbU) && nbU >= 1 ? Math.floor(nbU) : 1;
  const startU = Math.floor(posV);
  return { platformRackId, startU, endU: startU + height - 1 };
}

/**
 * 设备 U 位幂等 upsert 到 dc_rack_slots
 * （slotsRepo 无按 device 查询的方法，此处用参数化 SQL 实现完整的 upsert 语义）
 */
export function upsertRackSlot(
  deviceId: string,
  deviceType: 'server' | 'network_device' | 'pdu' | 'ups',
  placement: RackPlacement,
): void {
  if (placement.startU < 1 || placement.endU < placement.startU) {
    throw new Error(`U 位数据无效 (start=${placement.startU}, end=${placement.endU})`);
  }
  const existing = db
    .prepare('SELECT id FROM dc_rack_slots WHERE device_id = ? AND device_type = ?')
    .get(deviceId, deviceType) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE dc_rack_slots
      SET rack_id = ?, start_u = ?, end_u = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(placement.platformRackId, placement.startU, placement.endU, existing.id);
  } else {
    db.prepare(`
      INSERT INTO dc_rack_slots (id, rack_id, device_id, device_type, start_u, end_u, position_face, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'front', datetime('now','localtime'), datetime('now','localtime'))
    `).run(crypto.randomUUID(), placement.platformRackId, deviceId, deviceType, placement.startU, placement.endU);
  }
}
