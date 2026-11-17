/*
 * Хранилище в YDB (serverless): одна таблица kv (k Utf8, v Json).
 * Объектов мало (десятки заявок в день), поэтому хватает простого ключ → JSON.
 */
'use strict';

const { Driver, MetadataAuthService, TypedValues, TypedData, TableDescription, Column, Types } = require('ydb-sdk');

const TABLE = 'kv';

function ydbStore(endpoint, database) {
  let driverPromise = null;

  async function driver() {
    if (!driverPromise) {
      driverPromise = (async () => {
        const d = new Driver({ endpoint, database, authService: new MetadataAuthService() });
        if (!(await d.ready(10000))) throw new Error('YDB не отвечает');
        await d.tableClient.withSession(async (s) => {
          try {
            await s.createTable(TABLE, new TableDescription()
              .withColumn(new Column('k', Types.optional(Types.UTF8)))
              .withColumn(new Column('v', Types.optional(Types.JSON)))
              .withPrimaryKey('k'));
          } catch (e) {
            if (!/already exists|ALREADY_EXISTS/i.test(String(e && e.message))) throw e;
          }
        });
        return d;
      })().catch((e) => { driverPromise = null; throw e; });
    }
    return driverPromise;
  }

  async function run(query, params) {
    const d = await driver();
    return d.tableClient.withSession(async (s) => {
      const r = await s.executeQuery(query, params);
      return r.resultSets && r.resultSets[0] ? TypedData.createNativeObjects(r.resultSets[0]) : [];
    });
  }

  return {
    async get(k) {
      const rows = await run(`DECLARE $k AS Utf8; SELECT v FROM ${TABLE} WHERE k = $k;`, { $k: TypedValues.utf8(k) });
      return rows.length && rows[0].v ? JSON.parse(rows[0].v) : null;
    },
    async put(k, v) {
      await run(`DECLARE $k AS Utf8; DECLARE $v AS Json; UPSERT INTO ${TABLE} (k, v) VALUES ($k, $v);`,
        { $k: TypedValues.utf8(k), $v: TypedValues.json(JSON.stringify(v)) });
    },
    async del(k) {
      await run(`DECLARE $k AS Utf8; DELETE FROM ${TABLE} WHERE k = $k;`, { $k: TypedValues.utf8(k) });
    },
    async list(prefix) {
      // все ключи с префиксом: диапазон [prefix, prefix + '￿')
      const rows = await run(`DECLARE $a AS Utf8; DECLARE $b AS Utf8; SELECT v FROM ${TABLE} WHERE k >= $a AND k < $b LIMIT 1000;`,
        { $a: TypedValues.utf8(prefix), $b: TypedValues.utf8(prefix + '￿') });
      return rows.map((r) => JSON.parse(r.v));
    }
  };
}

module.exports = { ydbStore };
