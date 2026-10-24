import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {createStorageBackup} from '../storage/backup.js';

test('main 001–009 and branch 001–020 WAL backups upgrade without modifying their source or historical rows',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ogid-migration019-'));
  try{
    for(const version of [9,18,19,20]){
      const directory=join(root,`migrations-${version}`);mkdirSync(directory);
      for(const name of readdirSync(new URL('../storage/migrations/',import.meta.url)))
        if(Number(name.slice(0,3))<=version)copyFileSync(new URL(`../storage/migrations/${name}`,import.meta.url),join(directory,name));
      const file=join(root,`source-${version}.sqlite`),db=new Database(file);
      let candidate;
      try{
        db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');migrate(db,directory);
        db.prepare('INSERT INTO pipeline_runs VALUES(?,?,?,?,?,?,NULL)').run('retained','storage','2026-10-21','2026-10-22','healthy','{"articles":42}');
        const original=db.prepare('SELECT * FROM pipeline_runs').all(),checksums=db.prepare('SELECT version,checksum FROM schema_migrations').all();
        const backup=await createStorageBackup(file,join(root,`candidate-${version}.sqlite`));assert.equal(backup.verified,true);
        candidate=new Database(backup.destination);assert.equal(migrate(candidate).length,22);
        assert.deepEqual(candidate.prepare('SELECT * FROM pipeline_runs').all(),original);
        assert.deepEqual(candidate.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=?').all(version),checksums);
        assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version,version);
        assert.equal(candidate.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(candidate.pragma('foreign_key_check'),[]);
        assert.equal(candidate.prepare('SELECT count(*) AS n FROM candle_validations').get().n,0);
        const plan=candidate.prepare("EXPLAIN QUERY PLAN SELECT snapshot_id FROM agent_snapshots WHERE json_extract(manifest_json,'$.sealed')=0 AND json_extract(manifest_json,'$.building.jobId')=? ORDER BY as_of LIMIT 1").all('job');
        assert.ok(plan.some(row=>row.detail.includes('agent_snapshots_building_job')));
        assert.ok(candidate.prepare('EXPLAIN QUERY PLAN SELECT run_id FROM agent_runs ORDER BY started_at DESC LIMIT 20').all().some(row=>row.detail.includes('agent_runs_started')));
      }finally{candidate?.close();db.close();}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
