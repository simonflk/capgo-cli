import { program } from 'commander'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import ciDetect from '@npmcli/ci-detect';
import * as p from '@clack/prompts';
import { checkLatest } from '../api/update';
import { encryptSource } from '../api/crypto';
import { baseKeyPub, defaulPublicKey } from '../utils';

interface Options {
  key?: string
  keyData?: string
}

export const encryptZip = async (zipPath: string, options: Options) => {
  p.intro(`Encryption`);

  await checkLatest();
  // write in file .capgo the apikey in home directory

  if (!existsSync(zipPath)) {
    p.log.error(`Error: Zip not found at the path ${zipPath}`);
    program.error('');
  }

  const keyPath = options.key || baseKeyPub
  // check if publicKey exist

  let publicKey = options.keyData || "";

  if (!existsSync(keyPath) && !publicKey) {
    p.log.warning(`Cannot find public key ${keyPath} or as keyData option`);
    if (ciDetect()) {
      p.log.error(`Error: Missing public key`);
      program.error('');
    }
    const res = await p.confirm({ message: 'Do you want to use our public key ?' })
    if (!res) {
      p.log.error(`Error: Missing public key`);
      program.error('');
    }
    publicKey = defaulPublicKey
  } else if (existsSync(keyPath)) {
    // open with fs publicKey path
    const keyFile = readFileSync(keyPath)
    publicKey = keyFile.toString()
  }

  const zipFile = readFileSync(zipPath)
  const encodedZip = encryptSource(zipFile, publicKey)
  p.log.success(`ivSessionKey: ${encodedZip.ivSessionKey}`);
  // write decodedZip in a file
  writeFileSync(`${zipPath}_encrypted.zip`, encodedZip.encryptedData)
  p.log.success(`Encrypted zip saved at ${zipPath}_encrypted.zip`);
  p.outro(`Done ✅`);
  process.exit()
}
