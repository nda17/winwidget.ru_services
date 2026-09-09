// Narrow, encrypted production preflight for the Support rollout. Never log
// captured SSH output: it includes exact owner env bytes and container env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseEnv } from 'node:util';

const operation = JSON.parse(readFileSync('.github/support-chat-operation.json', 'utf8'));
if (operation.schemaVersion !== 1 || !['inspect', 'sync-env', 'restore-worker'].includes(operation.action) ||
    typeof operation.publicKey !== 'string' || operation.publicKey.length > 5000 ||
    (operation.supportChat !== undefined && typeof operation.supportChat !== 'boolean') ||
    (operation.supportWorkerLogs !== undefined &&
      (operation.action !== 'inspect' || typeof operation.supportWorkerLogs !== 'boolean')) ||
    (operation.databaseProbeSourceOnly !== undefined &&
      (typeof operation.databaseProbeSourceOnly !== 'boolean' || !operation.databaseProbeRevision)) ||
    (operation.databaseProbeRevision !== undefined &&
      (operation.action !== 'inspect' || typeof operation.databaseProbeRevision !== 'string' || !/^[a-f0-9]{40}$/.test(operation.databaseProbeRevision)))) {
  throw new Error('Unsupported Support preflight operation');
}
const restore = operation.action === 'restore-worker' ? operation.restore : null;
if (restore && (!/^[a-f0-9]{40}$/.test(restore.releaseRevision) ||
    !/^[a-f0-9]{40}$/.test(restore.imageRevision) || !/^[a-f0-9]{64}$/.test(restore.containerId) ||
    !/^sha256:[a-f0-9]{64}$/.test(restore.imageId))) throw new Error('Invalid bounded Support worker recovery');
if (operation.action === 'restore-worker' && !restore) throw new Error('Missing Support worker recovery identity');
let sync = null;
if (operation.action === 'sync-env') {
  const payload = process.env.SUPPORT_OPS_ENV_PAYLOAD;
  if (!payload || !operation.files || Object.keys(operation.files).length !== 4) throw new Error('Missing bounded Support env update');
  const files = JSON.parse(gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: 2097152 }));
  const allowed = {
    canonical: ['GATEWAY_ROUTES_JSON', 'SUPPORT_WEB_CHAT_ENABLED', 'SUPPORT_CRM_ACCESS_BASE_URL', 'SUPPORT_CRM_ACCESS_TOKEN', 'CRM_ACCESS_SUPPORT_TOKEN', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'SUPPORT_S3_ENDPOINT', 'SUPPORT_S3_REGION', 'SUPPORT_S3_BUCKET', 'SUPPORT_S3_FORCE_PATH_STYLE', 'SUPPORT_S3_ACCESS_KEY_ID', 'SUPPORT_S3_SECRET_ACCESS_KEY', 'NOTIFICATION_DELIVERY_KINDS'],
    crm: ['CRM_ACCESS_SUPPORT_TOKEN'],
    support: ['SUPPORT_WEB_CHAT_ENABLED', 'SUPPORT_CRM_ACCESS_BASE_URL', 'SUPPORT_CRM_ACCESS_TOKEN', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'SUPPORT_S3_ENDPOINT', 'SUPPORT_S3_REGION', 'SUPPORT_S3_BUCKET', 'SUPPORT_S3_FORCE_PATH_STYLE', 'SUPPORT_S3_ACCESS_KEY_ID', 'SUPPORT_S3_SECRET_ACCESS_KEY', 'CORS_ALLOWED_ORIGINS'],
    notificationDelivery: ['SUPPORT_INTERNAL_BASE_URL', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'TELEGRAM_SUPPORT_BOT_TOKEN', 'NOTIFICATION_DELIVERY_KINDS']
  };
  if (Object.keys(files).sort().join(',') !== Object.keys(operation.files).sort().join(',')) throw new Error('Support env file set mismatch');
  for (const [name, plan] of Object.entries(operation.files)) {
    if (!allowed[name] || !/^[a-f0-9]{64}$/.test(plan.expectedSha256) || !/^[a-f0-9]{64}$/.test(plan.sha256) || !Array.isArray(plan.changedKeys) || plan.changedKeys.some(key => !allowed[name].includes(key))) throw new Error('Invalid Support env plan');
    const bytes = Buffer.from(files[name], 'base64');
    if (bytes.length > 524288 || createHash('sha256').update(bytes).digest('hex') !== plan.sha256) throw new Error('Support env checksum mismatch');
    const parsed = parseEnv(bytes.toString('utf8'));
    if (plan.changedKeys.some(key => typeof parsed[key] !== 'string')) throw new Error('Missing planned Support env key');
  }
  sync = { plans: operation.files, files };
}
const directory = process.env.RUNNER_TEMP;
if (!directory) throw new Error('This operation requires the CI runner');
const sshDirectory = join(directory, 'support-chat-ssh');
mkdirSync(sshDirectory, { recursive: true, mode: 0o700 });
const identityFile = join(sshDirectory, 'key');
const hostsFile = join(sshDirectory, 'known_hosts');
for (const [file, name] of [[identityFile, 'SUPPORT_OPS_SSH_PRIVATE_KEY'], [hostsFile, 'SUPPORT_OPS_SSH_KNOWN_HOSTS']]) {
  if (!process.env[name]) throw new Error('Missing pinned SSH configuration');
  writeFileSync(file, process.env[name].trimEnd() + '\n', { mode: 0o600 });
}
const host = process.env.SUPPORT_OPS_SSH_HOST;
const port = process.env.SUPPORT_OPS_SSH_PORT || '22';
const user = process.env.SUPPORT_OPS_SSH_USER;
if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host || '') ||
    !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || user !== 'root') {
  throw new Error('Invalid pinned SSH destination');
}
const remote = String.raw`
import os, sys, json, stat, hashlib, base64, subprocess, tempfile, re, fcntl, glob, time
root='/opt/winwidget'
paths={
 'canonical':root+'/deploy/backend/.env.production',
 'crm':root+'/deploy/backend/crm/.env.production',
 'identity':root+'/winwidget.ru_services/apps/identity/.env.production',
 'notificationDelivery':root+'/winwidget.ru_services/apps/notification-delivery/.env.production',
 'operations':root+'/winwidget.ru_services/apps/operations/.env.production',
 'support':root+'/winwidget.ru_services/apps/support/.env.production',
 'crmAccess':root+'/winwidget.ru_services/apps/crm-access/.env.production'
}
result={'schemaVersion':1,'files':{},'containers':[],'ledgers':{}}
stage='files'
sync=SYNC_INPUT
restore=RESTORE_WORKER_INPUT
if sync is not None or restore is not None:
 lock_path=root+'/deploy/backend/.production-deploy.lock'
 lock_fd=os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 lock_info=os.fstat(lock_fd)
 if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid!=0 or lock_info.st_gid!=0 or stat.S_IMODE(lock_info.st_mode)!=0o600 or lock_info.st_nlink!=1: raise RuntimeError('Unsafe deploy lock')
 fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
if restore is not None:
 stage='restore-worker'
 docker_env={'PATH':os.environ['PATH'],'DOCKER_HOST':'unix:///var/run/docker.sock'}
 def docker(*args,timeout=30):
  return subprocess.run(['docker',*args],check=True,capture_output=True,text=True,timeout=timeout,env=docker_env).stdout
 def worker():
  ids=docker('ps','--all','--no-trunc','--filter','label=com.docker.compose.project=winwidget','--filter','label=com.docker.compose.service=support-worker','--format','{{.ID}}').split()
  if len(ids)!=1: raise RuntimeError('Support worker identity is not unique')
  return json.loads(docker('inspect',ids[0]))[0]
 current=worker()
 if current['Id']!=restore['containerId'] or current['Image']!=restore['imageId'] or current['Config']['Labels'].get('org.opencontainers.image.revision')!=restore['imageRevision']: raise RuntimeError('Support worker recovery baseline changed')
 if current['State'].get('Health',{}).get('Status')!='unhealthy': raise RuntimeError('Support worker no longer needs recovery')
 matches=glob.glob(root+'/deploy/backend/.support-chat-activate-release-'+restore['releaseRevision']+'.*')
 if len(matches)!=1: raise RuntimeError('Support recovery directory is not unique')
 directory=matches[0];info=os.lstat(directory)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o700: raise RuntimeError('Unsafe Support recovery directory')
 rollback=directory+'/rollback-winwidget.json';info=os.lstat(rollback)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or info.st_size>2097152: raise RuntimeError('Unsafe Support recovery file')
 with open(rollback) as file: config=json.load(file)
 service=config['services']['support-worker']
 before=dict(item.split('=',1) for item in current['Config']['Env']);after=service['environment']
 if before.get('SUPPORT_WEB_CHAT_ENABLED')!='true' or after.get('SUPPORT_WEB_CHAT_ENABLED')!='false' or before.get('APP_REVISION')!=restore['imageRevision'] or service['image']!=restore['imageId']: raise RuntimeError('Support recovery configuration is invalid')
 before['SUPPORT_WEB_CHAT_ENABLED']='false'
 if before!=after: raise RuntimeError('Unrelated Support recovery environment change')
 docker('compose','--project-name','winwidget','-f',rollback,'up','--detach','--no-deps','--no-build','--pull','never','support-worker',timeout=60)
 for attempt in range(45):
  recovered=worker()
  if recovered['State'].get('Health',{}).get('Status')=='healthy': break
  time.sleep(2)
 else: raise RuntimeError('Recovered Support worker did not become healthy')
 if recovered['Image']!=restore['imageId'] or dict(item.split('=',1) for item in recovered['Config']['Env'])!=after: raise RuntimeError('Support recovery postcondition failed')
 result['workerRecovery']={'healthy':True,'imageRevision':restore['imageRevision']}
 stage='files'
if sync is not None:
 originals={}
 staged={}
 try:
  for name,plan in sync['plans'].items():
   path=paths[name]
   info=os.lstat(path)
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1: raise RuntimeError('Unsafe update target')
   with open(path,'rb') as file: before=file.read(524289)
   after=base64.b64decode(sync['files'][name],validate=True)
   if hashlib.sha256(before).hexdigest()!=plan['expectedSha256'] or hashlib.sha256(after).hexdigest()!=plan['sha256']: raise RuntimeError('Update baseline mismatch')
   allowed=set(plan['changedKeys'])
   def preserve(data):
    output=[]
    for line in data.decode().splitlines():
     match=re.match(r'^([A-Z][A-Z0-9_]*)=',line)
     if match and match.group(1) in allowed: continue
     output.append(line)
    return output
   if preserve(before)!=preserve(after): raise RuntimeError('Unrelated env lines changed')
   originals[name]=before
   fd,temp=tempfile.mkstemp(prefix='.support-env-',dir=os.path.dirname(path))
   with os.fdopen(fd,'wb') as file:
    file.write(after);file.flush();os.fsync(file.fileno())
   os.chmod(temp,0o600);os.chown(temp,0,0);staged[name]=temp
  changed=[]
  try:
   for name,temp in staged.items():
    os.replace(temp,paths[name]);changed.append(name)
   for name,plan in sync['plans'].items():
    with open(paths[name],'rb') as file: after=file.read()
    if hashlib.sha256(after).hexdigest()!=plan['sha256']: raise RuntimeError('Update verification failed')
  except Exception:
   for name in changed:
    fd,temp=tempfile.mkstemp(prefix='.support-env-rollback-',dir=os.path.dirname(paths[name]))
    with os.fdopen(fd,'wb') as file:
     file.write(originals[name]);file.flush();os.fsync(file.fileno())
    os.chmod(temp,0o600);os.chown(temp,0,0);os.replace(temp,paths[name])
   raise
 finally:
  for temp in staged.values():
   if os.path.exists(temp): os.unlink(temp)
for name,path in paths.items():
 if name=='crmAccess' and not os.path.exists(path): continue
 if not os.path.exists(path):
  result['files'][name]={'error':'MISSING'}
  continue
 info=os.lstat(path)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or info.st_size>524288:
  result['files'][name]={'error':'UNSAFE_METADATA','uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode),'regular':stat.S_ISREG(info.st_mode),'links':info.st_nlink,'bytes':info.st_size}
  continue
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as file: data=file.read(524289)
 result['files'][name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}
stage='containers'
ids=subprocess.run(['docker','ps','-q'],check=True,capture_output=True,text=True).stdout.split()
if ids: result['containers']=json.loads(subprocess.run(['docker','inspect',*ids],check=True,capture_output=True,text=True).stdout)
stage='ledgers'
for container in result['containers']:
 service=container.get('Config',{}).get('Labels',{}).get('com.docker.compose.service','')
 if not service.endswith('-postgres'): continue
 owner=service[:-9]
 if owner not in ['billing','campaigns','identity','notification-delivery','operations','platform','reporting','support','widgets','crm-access','crm-intake','crm-customers','crm-sales']: continue
 schema=owner.replace('-','_')
 sql='SELECT migration_name,checksum FROM '+schema+'._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
 check=subprocess.run(['docker','exec',container['Id'],'sh','-c','PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000" exec psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"','sh',sql],capture_output=True,text=True)
 if check.returncode==0:
  result['ledgers'][owner]=[{'name':line.split('|')[0],'checksum':line.split('|')[1]} for line in check.stdout.splitlines() if '|' in line]
 else: result['ledgers'][owner]={'unavailable':True}
if SUPPORT_CHAT_SMOKE_INPUT:
 # Best-effort metadata only. No message text, users, recipients, destinations or raw delivery payloads.
 smoke={'schemaVersion':1,'support':{'available':False},'notificationDelivery':{'available':False}}
 result['supportChat']=smoke
 def smoke_database(owner):
  matches=[c for c in result['containers'] if c.get('Config',{}).get('Labels',{}).get('com.docker.compose.service')==owner+'-postgres' and c.get('Config',{}).get('Labels',{}).get('com.docker.compose.project')=='winwidget']
  if len(matches)!=1: raise RuntimeError('Database unavailable')
  return matches[0]['Id']
 def smoke_query(container_id,sql):
  check=subprocess.run(['docker','exec',container_id,'sh','-c','PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000" exec psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"','sh',sql],capture_output=True,text=True,timeout=8)
  if check.returncode!=0 or len(check.stdout)>262144: raise RuntimeError('Diagnostic unavailable')
  return json.loads(check.stdout)
 def smoke_tables(container_id,tables):
  return smoke_query(container_id,'SELECT to_json('+ ' AND '.join("to_regclass('"+table+"') IS NOT NULL" for table in tables)+')') is True
 try:
  support_db=smoke_database('support')
  if smoke_tables(support_db,['support.web_conversations','support.web_messages','support.web_attachments','support.web_notification_settings','support.web_notification_intents']):
   smoke['support']=smoke_query(support_db,"""
WITH recent AS (SELECT id,number,status,created_at FROM support.web_conversations ORDER BY created_at DESC,id DESC LIMIT 20),
intents AS (SELECT i.id,i.event_id AS "eventId",i.conversation_id AS "conversationId",i.kind,i.status,
 CASE WHEN i.reason ~ '^[A-Z0-9_]{1,120}$' THEN i.reason ELSE NULL END AS reason,i.created_at AS "createdAt"
 FROM support.web_notification_intents i JOIN recent c ON c.id=i.conversation_id ORDER BY i.created_at DESC,i.id DESC LIMIT 120)
SELECT json_build_object('available',true,'intentsLimit',120,
 'counts',json_build_object('conversations',(SELECT count(*) FROM support.web_conversations),'messages',(SELECT count(*) FROM support.web_messages),'attachments',(SELECT count(*) FROM support.web_attachments),'intents',(SELECT count(*) FROM support.web_notification_intents)),
 'settings',(SELECT json_build_object('version',version,'enabled',enabled,'emailEnabled',email_enabled,'telegramEnabled',telegram_enabled,'clientEmailEnabled',client_email_enabled) FROM support.web_notification_settings WHERE id='singleton'),
 'conversations',COALESCE((SELECT json_agg(json_build_object('id',id,'number',number,'status',status) ORDER BY created_at DESC,id DESC) FROM recent),'[]'::json),
 'intents',COALESCE((SELECT json_agg(intents ORDER BY "createdAt" DESC,id DESC) FROM intents),'[]'::json))
""")
  else: smoke['support']['reason']='TABLES_NOT_MIGRATED'
 except Exception: smoke['support']={'available':False,'reason':'DIAGNOSTIC_UNAVAILABLE'}
 try:
  intents=smoke['support'].get('intents',[])
  if smoke['support'].get('available') is not True: smoke['notificationDelivery']['reason']='SUPPORT_UNAVAILABLE'
  elif not intents: smoke['notificationDelivery']={'available':True,'receipts':[],'outcomes':[],'failures':[]}
  else:
   nd_db=smoke_database('notification-delivery')
   if not smoke_tables(nd_db,['notification_delivery.delivery_receipts','notification_delivery.delivery_failures','notification_delivery.outbox_events']):
    smoke['notificationDelivery']['reason']='TABLES_NOT_MIGRATED'
   else:
    values=[]
    for item in intents:
     if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',item['eventId']) or item['kind'] not in ['support-team-email','support-team-telegram','support-client-email']: raise RuntimeError('Invalid intent metadata')
     values.append("('"+item['eventId']+"'::uuid,'"+item['kind']+"')")
    smoke['notificationDelivery']=smoke_query(nd_db,"""
WITH wanted(event_id,kind) AS (VALUES """+','.join(values)+"""),
receipts AS (SELECT r.event_id AS "eventId",r.consumer AS kind,r.status,r.delivered_at AS "deliveredAt",r.retry_attempt AS "retryAttempt" FROM notification_delivery.delivery_receipts r JOIN wanted w ON r.event_id=w.event_id AND r.consumer=w.kind),
outcomes AS (SELECT w.event_id AS "eventId",w.kind,o.status AS "outboxStatus",
 CASE WHEN o.payload->>'status' IN ('DELIVERED','SKIPPED','FAILED') THEN o.payload->>'status' ELSE NULL END AS "deliveryStatus",
 CASE WHEN o.payload->>'reason' ~ '^[A-Z0-9_]{1,120}$' THEN o.payload->>'reason' ELSE NULL END AS reason,o.published_at AS "publishedAt"
 FROM wanted w CROSS JOIN (VALUES ('delivered'),('skipped'),('failed')) s(status)
 JOIN notification_delivery.outbox_events o ON o.deduplication_key='notification:'||w.event_id::text||':'||w.kind||':outcome:'||s.status||':v1'
 WHERE o.event_type='support.notification.delivery.outcome.v1'),
failures AS (SELECT f.event_id AS "eventId",f.consumer AS kind,f.category,f.retryable,f.resolution,f.resolved_at AS "resolvedAt",
 CASE WHEN f.normalized_code ~ '^[A-Z0-9_]{1,120}$' THEN f.normalized_code ELSE NULL END AS reason FROM notification_delivery.delivery_failures f JOIN wanted w ON f.event_id=w.event_id AND f.consumer=w.kind)
SELECT json_build_object('available',true,'receipts',COALESCE((SELECT json_agg(receipts) FROM receipts),'[]'::json),'outcomes',COALESCE((SELECT json_agg(outcomes) FROM outcomes),'[]'::json),'failures',COALESCE((SELECT json_agg(failures) FROM failures),'[]'::json))
""")
 except Exception: smoke['notificationDelivery']={'available':False,'reason':'DIAGNOSTIC_UNAVAILABLE'}
probe_revision=DATABASE_PROBE_REVISION_INPUT
probe_source_only=DATABASE_PROBE_SOURCE_ONLY_INPUT
if probe_revision is not None:
 # Exact candidate images and owner env files; only connection metadata and full migration ledgers.
 probes={}
 result.setdefault('supportChat',{'schemaVersion':1})['databaseProbe']={'revision':probe_revision,'owners':probes}
 probe_source=r"""
const owner=process.argv[1], schema=owner.replaceAll('-','_');
const output={available:false,stage:'source',uid:process.getuid(),gid:process.getgid(),prismaCode:null,sqlState:null};
const finish=()=>process.stdout.write(JSON.stringify(output));
const timer=setTimeout(()=>{output.available=false;output.errorCode='QUERY_TIMEOUT';finish();process.exit(0)},13000);
(async()=>{
 let client;
 try {
  const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma/migrations';
  const fsCode=error=>typeof error?.code==='string'&&/^E[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'FS_UNAVAILABLE';
  const metadata=path=>{try{const info=fs.lstatSync(path);return {kind:info.isSymbolicLink()?'SYMLINK':info.isDirectory()?'DIRECTORY':info.isFile()?'FILE':'OTHER',uid:info.uid,gid:info.gid,mode:(info.mode&0o7777).toString(8),bytes:info.size}}catch(error){return {errorCode:fsCode(error)}}};
  output.source={exists:fs.existsSync(root),parents:['/app','/app/prisma',root].map(path=>({path,...metadata(path)})),children:[]};
  output.source.realpath=fs.realpathSync(root);
  const entries=fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
  output.source.childCount=entries.length;output.source.truncated=entries.length>256;
  let hashedBytes=0;
  for(const item of entries.slice(0,256)){
   const validName=/^\d{14}_[a-z0-9_]+$/.test(item.name);
   const entry={name:/^[A-Za-z0-9_.-]{1,200}$/.test(item.name)?item.name:'UNSAFE_FILENAME',validName,...metadata(root+'/'+item.name)};
   output.source.children.push(entry);
   if(!validName||entry.kind!=='DIRECTORY')continue;
   const filename=root+'/'+item.name+'/migration.sql';
   entry.sql=metadata(filename);
   if(entry.sql.kind!=='FILE')continue;
   if(entry.sql.bytes>2097152||hashedBytes+entry.sql.bytes>16777216){entry.sql.errorCode='HASH_SIZE_LIMIT';continue}
   try{const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const data=fs.readFileSync(fd);hashedBytes+=data.length;entry.sql.sha256=crypto.createHash('sha256').update(data).digest('hex')}finally{fs.closeSync(fd)}}catch(error){entry.sql.errorCode=fsCode(error)}
  }
  if(process.argv[2]==='source-only'){output.available=true;return}
  output.stage='client';
  const key=owner==='notification-delivery'?'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION':schema.toUpperCase()+'_MIGRATION_DATABASE_URL';
  if(!process.env[key]){output.errorCode='MISSING_MIGRATION_URL';return}
  const url=new URL(process.env[key]);
  const ports={identity:'55438','crm-access':'55442',operations:'55441','notification-delivery':'55432',support:'55440'};
  if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!==ports[owner]||url.pathname!=='/winwidget_'+schema||url.searchParams.get('schema')!==schema||decodeURIComponent(url.username)!=='winwidget_'+schema+'_migration'||!url.password||url.hash||url.searchParams.get('sslmode')!=='disable'||[...url.searchParams.keys()].some(key=>!['schema','sslmode','connection_limit','pool_timeout','connect_timeout'].includes(key)||url.searchParams.getAll(key).length!==1)){output.errorCode='MIGRATION_URL_CONTRACT';return}
  url.searchParams.set('connection_limit','1');url.searchParams.set('pool_timeout','5');url.searchParams.set('connect_timeout','5');
  url.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000');
  const {PrismaClient}=require('@prisma/'+owner+'-client');
  client=new PrismaClient({datasources:{db:{url:url.href}},log:[]});
  output.stage='connect';await client.$connect();
  output.stage='identity';
  output.identity=await client.$queryRawUnsafe("SELECT current_database() AS database, current_user AS username, current_schema() AS schema, pg_is_in_recovery() AS recovery, current_setting('server_version_num') AS \"serverVersion\", current_setting('transaction_read_only')='on' AS \"readOnly\"");
  if(output.identity.length!==1||output.identity[0].readOnly!==true){output.errorCode='READ_ONLY_NOT_ENFORCED';return}
  output.stage='ledger';
  output.migrations=await client.$queryRawUnsafe('SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack" FROM "'+schema+'"._prisma_migrations ORDER BY migration_name, started_at, id');
  output.available=true;
 } catch(error) {
  output.errorCode='PROBE_FAILED';
  if(output.stage==='source'&&typeof error?.code==='string'&&/^E[A-Z0-9_]{1,40}$/.test(error.code))output.fsCode=error.code;
  const prismaCode=error?.code??error?.errorCode;
  if(typeof prismaCode==='string'&&/^P\d{4}$/.test(prismaCode))output.prismaCode=prismaCode;
  if(typeof error?.meta?.code==='string'&&/^[A-Z0-9]{5}$/.test(error.meta.code))output.sqlState=error.meta.code;
 } finally {
  try{if(client)await client.$disconnect()}catch{}
  clearTimeout(timer);finish();
 }
})();
"""
 for owner,path_key in [('identity','identity'),('crm-access','crm'),('operations','operations'),('notification-delivery','notificationDelivery'),('support','support')]:
  entry={'available':False,'stage':'image'}
  probes[owner]=entry
  try:
   if 'base64' not in result['files'].get(path_key,{}):
    entry['errorCode']='OWNER_ENV_UNAVAILABLE';continue
   tag='winwidget-'+owner+':git-'+probe_revision
   inspection=subprocess.run(['docker','image','inspect',tag],capture_output=True,text=True,timeout=5)
   if inspection.returncode!=0:
    entry['errorCode']='CANDIDATE_IMAGE_UNAVAILABLE';continue
   images=json.loads(inspection.stdout)
   if len(images)!=1 or not re.fullmatch(r'sha256:[a-f0-9]{64}',images[0].get('Id','')) or tag not in (images[0].get('RepoTags') or []) or images[0].get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=probe_revision:
    entry['errorCode']='CANDIDATE_IMAGE_MISMATCH';continue
   image_id=images[0]['Id']
   entry['imageId']=image_id
   common=['docker','run','--rm','--read-only','--log-driver','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--memory-swap','256m','--cpus','1','--pids-limit','64','--ulimit','core=0:0','--tmpfs','/tmp:rw,nosuid,size=16m','--env','NODE_OPTIONS=--max-old-space-size=96','--entrypoint','node']
   access=['--network','none'] if probe_source_only else ['--network','host','--env-file',paths[path_key]]
   check=subprocess.run(common+access+['--user','0:0',image_id,'-e',probe_source,owner]+(['source-only'] if probe_source_only else []),capture_output=True,text=True,timeout=18)
   if check.returncode!=0 or len(check.stdout)>1048576:
    entry['errorCode']='PROBE_PROCESS_FAILED';continue
   entry.update(json.loads(check.stdout))
   source_check=subprocess.run(common+['--network','none',image_id,'-e',probe_source,owner,'source-only'],capture_output=True,text=True,timeout=18)
   entry['defaultUserSource']=json.loads(source_check.stdout) if source_check.returncode==0 and len(source_check.stdout)<=1048576 else {'available':False,'errorCode':'SOURCE_PROCESS_FAILED'}
  except Exception: entry['errorCode']='PROBE_UNAVAILABLE'
 broker={'available':False}
 result['supportChat']['broker']=broker
 try:
  gateways=[c for c in result['containers'] if c.get('Config',{}).get('Labels',{}).get('com.docker.compose.service')=='api-gateway' and c.get('Config',{}).get('Labels',{}).get('com.docker.compose.project')=='winwidget']
  if len(gateways)!=1 or 'base64' not in result['files'].get('canonical',{}): raise RuntimeError('Broker probe unavailable')
  gateway=gateways[0]
  gateway_image=gateway.get('Image','')
  if not re.fullmatch(r'sha256:[a-f0-9]{64}',gateway_image): raise RuntimeError('Gateway image unavailable')
  inspection=subprocess.run(['docker','image','inspect',gateway_image],capture_output=True,text=True,timeout=5)
  images=json.loads(inspection.stdout) if inspection.returncode==0 else []
  revision=gateway.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision','')
  if len(images)!=1 or images[0].get('Id')!=gateway_image or not re.fullmatch(r'[a-f0-9]{40}',revision) or images[0].get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=revision: raise RuntimeError('Gateway image mismatch')
  broker_source=r"""
const output={available:false};
(async()=>{try{
 if(process.env.RABBITMQ_MANAGEMENT_URL!=='http://127.0.0.1:15672'||process.env.RABBITMQ_VHOST!=='winwidget'||!process.env.RABBITMQ_ADMIN_USER||!process.env.RABBITMQ_ADMIN_PASSWORD){output.errorCode='BROKER_CONFIGURATION';return}
 const authorization='Basic '+Buffer.from(process.env.RABBITMQ_ADMIN_USER+':'+process.env.RABBITMQ_ADMIN_PASSWORD).toString('base64');
 const endpoints=[['exchanges','exchanges/winwidget',['name','vhost','type','durable','auto_delete','internal','arguments']],['queues','queues/winwidget',['name','vhost','type','durable','auto_delete','arguments','consumers']],['bindings','bindings/winwidget',['source','vhost','destination','destination_type','routing_key','arguments']],['permissions','permissions',['user','vhost','configure','read','write']],['topic_permissions','topic-permissions',['user','vhost','exchange','read','write']]];
 await Promise.all(endpoints.map(async([key,path,fields])=>{
  const response=await fetch('http://127.0.0.1:15672/api/'+path,{method:'GET',headers:{authorization},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok){output[key]={errorCode:'BROKER_HTTP',status:response.status};return}
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2097152){output[key]={errorCode:'BROKER_SIZE_LIMIT'};return}chunks.push(chunk)}
  const rows=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!Array.isArray(rows)||rows.length>2000){output[key]={errorCode:'BROKER_SHAPE'};return}
  output[key]=rows.map(row=>Object.fromEntries(fields.filter(field=>Object.hasOwn(row,field)).map(field=>[field,row[field]])));
 }));
 output.available=endpoints.every(([key])=>Array.isArray(output[key]));
}catch{output.errorCode='BROKER_REQUEST_FAILED'}finally{process.stdout.write(JSON.stringify(output))}})();
"""
  check=subprocess.run(['docker','run','--rm','--network','host','--read-only','--log-driver','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','192m','--memory-swap','192m','--cpus','1','--pids-limit','64','--ulimit','core=0:0','--env-file',paths['canonical'],'--env','NODE_OPTIONS=--max-old-space-size=64','--entrypoint','node',gateway_image,'-e',broker_source],capture_output=True,text=True,timeout=12)
  if check.returncode!=0 or len(check.stdout)>4194304: raise RuntimeError('Broker probe failed')
  broker.update(json.loads(check.stdout))
 except Exception: broker['errorCode']='BROKER_PROBE_UNAVAILABLE'
if SUPPORT_WORKER_LOGS_INPUT:
 # Captured logs remain inside the encrypted snapshot, never in summary.json or CI stdout.
 worker={'available':False}
 result.setdefault('supportChat',{'schemaVersion':1})['workerDiagnostics']=worker
 try:
  workers=[c for c in result['containers'] if c.get('Config',{}).get('Labels',{}).get('com.docker.compose.service')=='support-worker' and c.get('Config',{}).get('Labels',{}).get('com.docker.compose.project')=='winwidget']
  if len(workers)!=1 or not re.fullmatch(r'[a-f0-9]{64}',workers[0].get('Id','')): raise RuntimeError('Worker unavailable')
  worker['containerId']=workers[0]['Id']
  with tempfile.TemporaryFile() as captured_logs:
   check=subprocess.run(['docker','logs','--tail','120',workers[0]['Id']],stdout=captured_logs,stderr=subprocess.STDOUT,timeout=5)
   size=captured_logs.tell()
   captured_logs.seek(max(0,size-131072))
   worker.update({'available':check.returncode==0,'logs':captured_logs.read(131072).decode('utf8',errors='replace'),'logsTruncated':size>131072})
 except Exception: worker['errorCode']='WORKER_LOGS_UNAVAILABLE'
 try:
  if 'containerId' not in worker: raise RuntimeError('Worker unavailable')
  import http.client
  connection=http.client.HTTPConnection('127.0.0.1',5101,timeout=3)
  try:
   connection.request('GET','/health/ready')
   response=connection.getresponse()
   body=response.read(4097)
   worker['readiness']={'status':response.status,'body':body[:4096].decode('utf8',errors='replace'),'truncated':len(body)>4096}
  finally: connection.close()
 except Exception: worker['readiness']={'errorCode':'READINESS_UNAVAILABLE'}
stage='memory'
result['memoryAvailableKiB']=int(next(line.split()[1] for line in open('/proc/meminfo') if line.startswith('MemAvailable:')))
sys.stdout.write(json.dumps(result,separators=(',',':')))
`;
const sshArgs = ['-F','/dev/null','-i',identityFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
  '-o',`UserKnownHostsFile=${hostsFile}`,'-o','IdentitiesOnly=yes','-o','ConnectTimeout=15',
  '-o','LogLevel=ERROR','-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-p',port,`${user}@${host}`,'python3','-'];
const preparedRemote = remote.replace('SYNC_INPUT', sync ? `json.loads(base64.b64decode('${Buffer.from(JSON.stringify(sync)).toString('base64')}'))` : 'None')
  .replace('RESTORE_WORKER_INPUT', restore ? `json.loads(base64.b64decode('${Buffer.from(JSON.stringify(restore)).toString('base64')}'))` : 'None')
  .replace('SUPPORT_CHAT_SMOKE_INPUT', operation.supportChat === true ? 'True' : 'False')
  .replace('DATABASE_PROBE_REVISION_INPUT', operation.databaseProbeRevision ? JSON.stringify(operation.databaseProbeRevision) : 'None')
  .replace('DATABASE_PROBE_SOURCE_ONLY_INPUT', operation.databaseProbeSourceOnly === true ? 'True' : 'False')
  .replace('SUPPORT_WORKER_LOGS_INPUT', operation.supportWorkerLogs === true ? 'True' : 'False');
const guardedRemote = "import sys\nstage='initial'\ntry:\n" + preparedRemote.split('\n').map(line => ' '+line).join('\n') + "\nexcept Exception:\n sys.stderr.write('SUPPORT_PREFLIGHT_STAGE='+stage+'\\n')\n sys.exit(1)\n";
const result = spawnSync('ssh', sshArgs, { input: Buffer.from(guardedRemote), maxBuffer: 32 * 1024 * 1024, timeout: restore ? 240000 : 120000 });
let snapshot, captured;
if (result.status !== 0 || result.error) {
  const diagnostics = result.stderr?.toString('utf8') || '';
  const stage = diagnostics.match(/^SUPPORT_PREFLIGHT_STAGE=(initial|files|containers|ledgers|memory|restore-worker)$/m)?.[1];
  const reason = stage ? `REMOTE_${stage}` : /Permission denied/.test(diagnostics) ? 'SSH_AUTH_DENIED' : /Host key verification failed/.test(diagnostics) ? 'SSH_HOST_KEY' : /libcrypto|invalid format/.test(diagnostics) ? 'SSH_KEY_FORMAT' : 'SSH_TRANSPORT';
  snapshot = { error: reason, files: {}, containers: [], diagnostics: { status: result.status, code: result.error?.code, stderr: diagnostics } };
  captured = Buffer.from(JSON.stringify(snapshot));
} else {
  captured = result.stdout;
  snapshot = JSON.parse(captured.toString('utf8'));
}
const key = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const aad = Buffer.from(`support-chat-preflight-v1:${process.env.GITHUB_SHA}`);
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(captured),cipher.final()]);
mkdirSync('support-chat-preflight', { mode: 0o700 });
writeFileSync('support-chat-preflight/encrypted.json', JSON.stringify({
  schemaVersion:1,revision:process.env.GITHUB_SHA,aad:aad.toString('base64'),iv:iv.toString('base64'),
  key:publicEncrypt({key:operation.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),
  tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')
}), {mode:0o600});
const summary = { revision:process.env.GITHUB_SHA, error: snapshot.error, files:Object.fromEntries(Object.entries(snapshot.files).map(([name,file]) => [name,{sha256:file.sha256,bytes:file.bytes,error:file.error,uid:file.uid,gid:file.gid,mode:file.mode}])),
  containers:snapshot.containers.map(c=>({service:c.Config.Labels?.['com.docker.compose.service']||null,id:c.Id,image:c.Config.Image,health:c.State.Health?.Status||null})),
  memoryAvailableKiB:snapshot.memoryAvailableKiB, encryptedSha256:createHash('sha256').update(ciphertext).digest('hex') };
writeFileSync('support-chat-preflight/summary.json', JSON.stringify(summary,null,2),{mode:0o600});
console.log(snapshot.error ? 'Support operation failed; diagnostics encrypted and no captured output logged.' : 'Support production preflight encrypted; no env values or captured SSH output logged.');
if (snapshot.error) process.exitCode = 1;
