// Narrow, encrypted production preflight for the Support rollout. Never log
// captured SSH output: it includes exact owner env bytes and container env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { join } from 'node:path';

const operation = JSON.parse(readFileSync('.github/support-chat-operation.json', 'utf8'));
if (operation.schemaVersion !== 1 || operation.action !== 'inspect' ||
    typeof operation.publicKey !== 'string' || operation.publicKey.length > 5000) {
  throw new Error('Unsupported Support preflight operation');
}
const directory = process.env.RUNNER_TEMP;
if (!directory) throw new Error('This operation requires the CI runner');
const sshDirectory = join(directory, 'support-chat-ssh');
mkdirSync(sshDirectory, { recursive: true, mode: 0o700 });
const identityFile = join(sshDirectory, 'key');
const hostsFile = join(sshDirectory, 'known_hosts');
for (const [file, name] of [[identityFile, 'SUPPORT_OPS_SSH_PRIVATE_KEY'], [hostsFile, 'SUPPORT_OPS_SSH_KNOWN_HOSTS']]) {
  if (!process.env[name]) throw new Error('Missing pinned SSH configuration');
  writeFileSync(file, process.env[name], { mode: 0o600 });
}
const host = process.env.SUPPORT_OPS_SSH_HOST;
const port = process.env.SUPPORT_OPS_SSH_PORT || '22';
const user = process.env.SUPPORT_OPS_SSH_USER;
if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host || '') ||
    !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || user !== 'root') {
  throw new Error('Invalid pinned SSH destination');
}
const remote = String.raw`
import os, sys, json, stat, hashlib, base64, subprocess
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
for name,path in paths.items():
 if name=='crmAccess' and not os.path.exists(path): continue
 info=os.lstat(path)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or info.st_size>524288:
  raise RuntimeError('Unsafe environment file')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as file: data=file.read(524289)
 result['files'][name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}
ids=subprocess.run(['docker','ps','-q'],check=True,capture_output=True,text=True).stdout.split()
if ids: result['containers']=json.loads(subprocess.run(['docker','inspect',*ids],check=True,capture_output=True,text=True).stdout)
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
result['memoryAvailableKiB']=int(next(line.split()[1] for line in open('/proc/meminfo') if line.startswith('MemAvailable:')))
sys.stdout.write(json.dumps(result,separators=(',',':')))
`;
const sshArgs = ['-F','/dev/null','-i',identityFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
  '-o',`UserKnownHostsFile=${hostsFile}`,'-o','IdentitiesOnly=yes','-o','ConnectTimeout=15',
  '-o','LogLevel=ERROR','-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-p',port,`${user}@${host}`,'python3','-'];
const result = spawnSync('ssh', sshArgs, { input: remote, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
if (result.status !== 0 || result.error) throw new Error('Support production preflight failed; captured output is withheld');
const snapshot = JSON.parse(result.stdout.toString('utf8'));
const key = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const aad = Buffer.from(`support-chat-preflight-v1:${process.env.GITHUB_SHA}`);
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(result.stdout),cipher.final()]);
mkdirSync('support-chat-preflight', { mode: 0o700 });
writeFileSync('support-chat-preflight/encrypted.json', JSON.stringify({
  schemaVersion:1,revision:process.env.GITHUB_SHA,aad:aad.toString('base64'),iv:iv.toString('base64'),
  key:publicEncrypt({key:operation.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),
  tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')
}), {mode:0o600});
const summary = { revision:process.env.GITHUB_SHA, files:Object.fromEntries(Object.entries(snapshot.files).map(([name,file]) => [name,{sha256:file.sha256,bytes:file.bytes}])),
  containers:snapshot.containers.map(c=>({service:c.Config.Labels?.['com.docker.compose.service']||null,id:c.Id,image:c.Config.Image,health:c.State.Health?.Status||null})),
  memoryAvailableKiB:snapshot.memoryAvailableKiB, encryptedSha256:createHash('sha256').update(ciphertext).digest('hex') };
writeFileSync('support-chat-preflight/summary.json', JSON.stringify(summary,null,2),{mode:0o600});
console.log('Support production preflight encrypted; no env values or captured SSH output logged.');
