// Narrow, encrypted production preflight for the Support rollout. Never log
// captured SSH output: it includes exact owner env bytes and container env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseEnv } from 'node:util';

const operation = JSON.parse(readFileSync('.github/support-chat-operation.json', 'utf8'));
if (operation.schemaVersion !== 1 || !['inspect', 'sync-env'].includes(operation.action) ||
    typeof operation.publicKey !== 'string' || operation.publicKey.length > 5000) {
  throw new Error('Unsupported Support preflight operation');
}
let sync = null;
if (operation.action === 'sync-env') {
  const payload = process.env.SUPPORT_OPS_ENV_PAYLOAD;
  if (!payload || !operation.files || Object.keys(operation.files).length !== 4) throw new Error('Missing bounded Support env update');
  const files = JSON.parse(gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: 2097152 }));
  const allowed = {
    canonical: ['GATEWAY_ROUTES_JSON', 'SUPPORT_WEB_CHAT_ENABLED', 'SUPPORT_CRM_ACCESS_BASE_URL', 'SUPPORT_CRM_ACCESS_TOKEN', 'CRM_ACCESS_SUPPORT_TOKEN', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'SUPPORT_S3_ENDPOINT', 'SUPPORT_S3_REGION', 'SUPPORT_S3_BUCKET', 'SUPPORT_S3_FORCE_PATH_STYLE', 'SUPPORT_S3_ACCESS_KEY_ID', 'SUPPORT_S3_SECRET_ACCESS_KEY', 'NOTIFICATION_DELIVERY_KINDS'],
    crm: ['CRM_ACCESS_SUPPORT_TOKEN'],
    support: ['SUPPORT_WEB_CHAT_ENABLED', 'SUPPORT_CRM_ACCESS_BASE_URL', 'SUPPORT_CRM_ACCESS_TOKEN', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'SUPPORT_S3_ENDPOINT', 'SUPPORT_S3_REGION', 'SUPPORT_S3_BUCKET', 'SUPPORT_S3_FORCE_PATH_STYLE', 'SUPPORT_S3_ACCESS_KEY_ID', 'SUPPORT_S3_SECRET_ACCESS_KEY'],
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
import os, sys, json, stat, hashlib, base64, subprocess, tempfile, re, fcntl
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
if sync is not None:
 lock_path=root+'/deploy/backend/.production-deploy.lock'
 lock_fd=os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 lock_info=os.fstat(lock_fd)
 if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid!=0 or lock_info.st_gid!=0 or stat.S_IMODE(lock_info.st_mode)!=0o600 or lock_info.st_nlink!=1: raise RuntimeError('Unsafe deploy lock')
 fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
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
stage='memory'
result['memoryAvailableKiB']=int(next(line.split()[1] for line in open('/proc/meminfo') if line.startswith('MemAvailable:')))
sys.stdout.write(json.dumps(result,separators=(',',':')))
`;
const sshArgs = ['-F','/dev/null','-i',identityFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
  '-o',`UserKnownHostsFile=${hostsFile}`,'-o','IdentitiesOnly=yes','-o','ConnectTimeout=15',
  '-o','LogLevel=ERROR','-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-p',port,`${user}@${host}`,'python3','-'];
const preparedRemote = remote.replace('SYNC_INPUT', sync ? `json.loads(base64.b64decode('${Buffer.from(JSON.stringify(sync)).toString('base64')}'))` : 'None');
const guardedRemote = "import sys\nstage='initial'\ntry:\n" + preparedRemote.split('\n').map(line => ' '+line).join('\n') + "\nexcept Exception:\n sys.stderr.write('SUPPORT_PREFLIGHT_STAGE='+stage+'\\n')\n sys.exit(1)\n";
const result = spawnSync('ssh', sshArgs, { input: Buffer.from(guardedRemote), maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
let snapshot, captured;
if (result.status !== 0 || result.error) {
  const diagnostics = result.stderr?.toString('utf8') || '';
  const stage = diagnostics.match(/^SUPPORT_PREFLIGHT_STAGE=(initial|files|containers|ledgers|memory)$/m)?.[1];
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
