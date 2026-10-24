import {execFileSync} from 'node:child_process';
import {accessSync,constants,existsSync} from 'node:fs';
import {dirname} from 'node:path';

// Deployment safety: never create a replacement database on the root disk when
// the configured external volume is absent. Tests use their explicit temp paths.
export function assertStorageVolume(databasePath,{mountpoint=execFileSync,access=accessSync,exists=existsSync}={}) {
  if(databasePath.startsWith('/home/fedora/.local/share/ogid/db/')&&!exists(databasePath))throw Object.assign(Error('Configured operational SQLite image is missing'),{code:'STORAGE_DATABASE_MISSING'});
  if(!databasePath.startsWith('/srv/bitcoin/'))return;
  try{mountpoint('mountpoint',['-q','/srv/bitcoin'],{stdio:'ignore',timeout:2000});}
  catch{throw Object.assign(Error('Configured SQLite volume is not mounted'),{code:'STORAGE_VOLUME_UNAVAILABLE'});}
  try{access(dirname(databasePath),constants.R_OK|constants.W_OK);}
  catch{throw Object.assign(Error('Configured SQLite volume is not writable'),{code:'STORAGE_VOLUME_READ_ONLY'});}
  if(databasePath.startsWith('/srv/bitcoin/ogid/db/')&&!exists(databasePath))throw Object.assign(Error('Configured operational SQLite image is missing'),{code:'STORAGE_DATABASE_MISSING'});
}
