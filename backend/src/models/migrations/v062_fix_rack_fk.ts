/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Migration } from './migrationFramework';
import { logger } from '../../utils/logger';

/**
 * Migration v062 — 修复 v058 RENAME 级联污染的 dc_racks 外键
 *
 * v058 重建 dc_racks 时用了 `ALTER TABLE dc_racks RENAME TO _dc_racks_backup`，
 * SQLite 会级联改写所有引用 dc_racks 的子表外键（指向新表名 _dc_racks_backup），
 * 随后备份表被 DROP，导致 dc_rack_slots / dc_power_feeds 的 FK 指向不存在的表。
 * 后果：PRAGMA foreign_keys=ON 的连接对 dc_rack_slots 做 INSERT/UPDATE 时报
 *   `no such table: main._dc_racks_backup`
 * （2026-08-17 iTop CMDB 同步机柜/U 位时触发实测发现）
 *
 * 修复：按"建 _new → 拷数据 → DROP 旧 → RENAME"重建两张表，FK 修正回 dc_racks。
 * 全程 PRAGMA foreign_keys=OFF，避免 RENAME 再次级联污染 / 脏数据阻塞拷贝。
 * 所有语句均为静态字面量（无外部输入），逐条 prepared 执行。
 */

const REBUILD_DC_RACK_SLOTS_STATEMENTS: string[] = [
  `CREATE TABLE dc_rack_slots_new (
  id TEXT PRIMARY KEY,
  rack_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_type TEXT NOT NULL CHECK(device_type IN ('server','network_device','vm_host','pdu','ups','other')),
  device_type_id TEXT,
  start_u INTEGER NOT NULL,
  end_u INTEGER NOT NULL,
  position_face TEXT DEFAULT 'front',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (rack_id) REFERENCES dc_racks(id) ON DELETE CASCADE,
  FOREIGN KEY (device_type_id) REFERENCES device_types(id) ON DELETE SET NULL
)`,
  `INSERT INTO dc_rack_slots_new (id, rack_id, device_id, device_type, device_type_id, start_u, end_u, position_face, notes, created_at, updated_at)
SELECT id, rack_id, device_id, device_type, device_type_id, start_u, end_u, position_face, notes, created_at, updated_at FROM dc_rack_slots`,
  // DROP 表前先摘除 4 个跨表 trigger（挂在设备表上、引用 dc_rack_slots），
  // 否则表被 DROP 后这些 trigger 失效，会在后续语句编译时报 no such table
  `DROP TRIGGER IF EXISTS trg_servers_delete_clear_slots`,
  `DROP TRIGGER IF EXISTS trg_network_devices_delete_clear_slots`,
  `DROP TRIGGER IF EXISTS trg_vms_delete_clear_slots`,
  `DROP TRIGGER IF EXISTS trg_pdus_delete_clear_slots`,
  `DROP TABLE dc_rack_slots`,
  `ALTER TABLE dc_rack_slots_new RENAME TO dc_rack_slots`,
  `CREATE INDEX IF NOT EXISTS idx_dc_rack_slots_rack ON dc_rack_slots(rack_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dc_rack_slots_device ON dc_rack_slots(device_id)`,
  // 恢复设备删除时清理 slot 的跨表 trigger（定义来自 v059，原样恢复）
  `CREATE TRIGGER trg_servers_delete_clear_slots
AFTER DELETE ON servers
FOR EACH ROW
BEGIN
  DELETE FROM dc_rack_slots WHERE device_type = 'server' AND device_id = OLD.id;
END`,
  `CREATE TRIGGER trg_network_devices_delete_clear_slots
AFTER DELETE ON network_devices
FOR EACH ROW
BEGIN
  DELETE FROM dc_rack_slots WHERE device_type = 'network_device' AND device_id = OLD.id;
END`,
  `CREATE TRIGGER trg_vms_delete_clear_slots
AFTER DELETE ON virtual_machines
FOR EACH ROW
BEGIN
  DELETE FROM dc_rack_slots WHERE device_type = 'vm_host' AND device_id = OLD.id;
END`,
  `CREATE TRIGGER trg_pdus_delete_clear_slots
AFTER DELETE ON dc_pdus
FOR EACH ROW
BEGIN
  DELETE FROM dc_rack_slots WHERE device_type IN ('pdu','ups') AND device_id = OLD.id;
END`,
];

// v059 的设备存在性 trigger（DROP TABLE 时被一并删除，需重建）
const RECREATE_SLOTS_TRIGGER_STATEMENTS: string[] = [
  `CREATE TRIGGER IF NOT EXISTS trg_dc_rack_slots_validate_insert
BEFORE INSERT ON dc_rack_slots
FOR EACH ROW
WHEN
  (NEW.device_type = 'server'
    AND NOT EXISTS (SELECT 1 FROM servers WHERE id = NEW.device_id))
  OR (NEW.device_type = 'network_device'
    AND NOT EXISTS (SELECT 1 FROM network_devices WHERE id = NEW.device_id))
  OR (NEW.device_type = 'vm_host'
    AND NOT EXISTS (SELECT 1 FROM virtual_machines WHERE id = NEW.device_id))
  OR (NEW.device_type IN ('pdu', 'ups')
    AND NOT EXISTS (SELECT 1 FROM dc_pdus WHERE id = NEW.device_id))
  OR NEW.device_type NOT IN ('server','network_device','vm_host','pdu','ups','other')
BEGIN
  SELECT RAISE(ABORT, 'dc_rack_slots: device_id not found in corresponding table or device_type invalid');
END`,
];

const REBUILD_DC_POWER_FEEDS_STATEMENTS: string[] = [
  `CREATE TABLE dc_power_feeds_new (
  id TEXT PRIMARY KEY,
  power_panel_id TEXT NOT NULL,
  rack_id TEXT DEFAULT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','planned','failed','decommissioned')),
  feed_type TEXT DEFAULT 'primary' CHECK(feed_type IN ('primary','redundant')),
  supply TEXT DEFAULT 'ac' CHECK(supply IN ('ac','dc')),
  voltage REAL DEFAULT 220,
  amperage REAL DEFAULT 16,
  max_utilization_pct REAL DEFAULT 80,
  current_load_w REAL DEFAULT 0,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (power_panel_id) REFERENCES dc_power_panels(id) ON DELETE RESTRICT,
  FOREIGN KEY (rack_id) REFERENCES dc_racks(id) ON DELETE SET NULL
)`,
  `INSERT INTO dc_power_feeds_new (id, power_panel_id, rack_id, name, status, feed_type, supply, voltage, amperage, max_utilization_pct, current_load_w, description, created_at, updated_at)
SELECT id, power_panel_id, rack_id, name, status, feed_type, supply, voltage, amperage, max_utilization_pct, current_load_w, description, created_at, updated_at FROM dc_power_feeds`,
  `DROP TABLE dc_power_feeds`,
  `ALTER TABLE dc_power_feeds_new RENAME TO dc_power_feeds`,
  `CREATE INDEX IF NOT EXISTS idx_dc_power_feeds_panel ON dc_power_feeds(power_panel_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dc_power_feeds_rack ON dc_power_feeds(rack_id)`,
];

const POLLUTED_TABLES_SQL =
  'SELECT name FROM sqlite_master WHERE type=\'table\' AND sql LIKE \'%REFERENCES "_dc_racks_backup"%\'';
const REMAIN_POLLUTION_SQL =
  'SELECT COUNT(*) as c FROM sqlite_master WHERE type=\'table\' AND sql LIKE \'%REFERENCES "_dc_racks_backup"%\'';

/** 逐条以 prepared statement 执行静态 SQL（均为字面量常量，无外部输入） */
function runStatements(db: any, statements: string[]): void {
  for (const sql of statements) {
    db.prepare(sql).run();
  }
}

const v062FixRackFk: Migration = {
  id: '20260817000062',
  version: 62,
  name: 'fix_rack_fk_polluted_by_v058',
  description: 'Rebuild dc_rack_slots/dc_power_feeds to fix FK pointing to dropped _dc_racks_backup',

  up: async (db: any) => {
    logger.info('🔄 Fixing dc_racks FK polluted by v058 RENAME...');

    // 幂等：仍有表引用 _dc_racks_backup 才需要修复
    const polluted = db.prepare(POLLUTED_TABLES_SQL).all() as Array<{ name: string }>;
    const pollutedNames = polluted.map((p) => p.name);

    if (pollutedNames.length === 0) {
      logger.info('  ✓ 无 FK 污染，跳过');
      return;
    }
    logger.info(`  → 受污染表: ${pollutedNames.join(', ')}`);

    db.pragma('foreign_keys = OFF');
    try {
      if (pollutedNames.includes('dc_rack_slots')) {
        runStatements(db, REBUILD_DC_RACK_SLOTS_STATEMENTS);
        runStatements(db, RECREATE_SLOTS_TRIGGER_STATEMENTS);
        logger.info('  ✓ dc_rack_slots FK 已修复（含索引与 trigger 重建）');
      }

      if (pollutedNames.includes('dc_power_feeds')) {
        runStatements(db, REBUILD_DC_POWER_FEEDS_STATEMENTS);
        logger.info('  ✓ dc_power_feeds FK 已修复');
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }

    // 验证修复结果
    const remain = db.prepare(REMAIN_POLLUTION_SQL).get() as { c: number };
    if (remain.c > 0) {
      throw new Error(`v062 修复后仍存在 ${remain.c} 张表引用 _dc_racks_backup`);
    }
    logger.info('✅ dc_racks FK 污染修复完成');
  },

  down: async (_db: any) => {
    // 无需回滚：本迁移只是把 FK 修正回本应指向的 dc_racks
    logger.info('v062 down: no-op (FK fix is not revertible)');
  },
};

export default v062FixRackFk;
