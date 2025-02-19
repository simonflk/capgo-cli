import AdmZip from 'adm-zip';
import { program } from 'commander';
import { randomUUID } from 'crypto';
import * as p from '@clack/prompts';
import { existsSync, readFileSync } from 'fs';
import { checksum as getChecksum } from '@tomasklaen/checksum';
import ciDetect from '@npmcli/ci-detect';
import { checkLatest } from '../api/update';
import { OptionsBase } from '../api/utils';
import { checkAppExistsAndHasPermissionErr } from "../api/app";
import { encryptSource } from '../api/crypto';
import {
  hostWeb, getConfig, createSupabaseClient,
  updateOrCreateChannel, updateOrCreateVersion,
  formatError, findSavedKey, checkPlanValid,
  useLogSnag, verifyUser, regexSemver, baseKeyPub, convertAppName, defaulPublicKey
} from '../utils';

const alertMb = 20;

interface Options extends OptionsBase {
  bundle?: string
  path?: string
  channel?: string
  displayIvSession?: boolean
  external?: string
  key?: boolean | string
}

export const uploadBundle = async (appid: string, options: Options, shouldExit = true) => {
  p.intro(`Uploading`);
  await checkLatest();
  let { bundle, path, channel } = options;
  const { external, key = false, displayIvSession } = options;
  const apikey = options.apikey || findSavedKey()
  const snag = useLogSnag()

  channel = channel || 'dev';

  const config = await getConfig();
  appid = appid || config?.app?.appId
  // create bundle name format : 1.0.0-beta.x where x is a uuid
  const uuid = randomUUID().split('-')[0];
  bundle = bundle || config?.app?.package?.version || `0.0.1-beta.${uuid}`
  // check if bundle is valid 
  if (!regexSemver.test(bundle)) {
    p.log.error(`Your bundle name ${bundle}, is not valid it should follow semver convention : https://semver.org/`);
    program.error('');
  }
  path = path || config?.app?.webDir
  if (!apikey) {
    p.log.error(`Missing API key, you need to provide a API key to upload your bundle`);
    program.error('');
  }
  if (!appid || !bundle || !path) {
    p.log.error("Missing argument, you need to provide a appid and a bundle and a path, or be in a capacitor project");
    program.error('');
  }
  // check if path exist
  if (!existsSync(path)) {
    p.log.error(`Path ${path} does not exist, build your app first, or provide a valid path`);
    program.error('');
  }
  p.log.info(`Upload ${appid}@${bundle} started from path "${path}" to Capgo cloud`);

  const supabase = createSupabaseClient(apikey)
  const userId = await verifyUser(supabase, apikey, ['write', 'all', 'upload']);
  await checkPlanValid(supabase, userId, false)
  // Check we have app access to this appId
  await checkAppExistsAndHasPermissionErr(supabase, appid, apikey);

  // checking if user has access rights before uploading
  const { data: versionExist, error: versionExistError } = await supabase
    .rpc('exist_app_versions', { apikey, name_version: bundle, appid })
    .single()

  if (versionExist || versionExistError) {
    p.log.error(`This app bundle already exist or was deleted, you cannot re-upload it ${formatError(versionExistError)}`);
    program.error('');
  }
  const { data: isTrial, error: isTrialsError } = await supabase
    .rpc('is_trial', { userid: userId })
    .single()
  if (isTrial && isTrial > 0 || isTrialsError) {
    p.log.warn(`WARNING !!\nTrial expires in ${isTrial} days`);
    p.log.warn(`Upgrade here: ${hostWeb}/dashboard/settings/plans`);
  }

  const { data: app, error: appError } = await supabase
    .rpc('exist_app', { appid, apikey })
    .single()

  if (!app || appError) {
    p.log.error(`Cannot find app ${appid} in your account ${formatError(appError)}`);
    program.error('');
  }
  // check if app already exist
  const { data: appVersion, error: appVersionError } = await supabase
    .rpc('exist_app_versions', { appid, apikey, name_version: bundle })
    .single()

  if (appVersion || appVersionError) {
    p.log.error(`Version already exists ${formatError(appVersionError)}`);
    program.error('');
  }
  const fileName = randomUUID()
  let sessionKey;
  let checksum = ''
  if (!external) {
    const zip = new AdmZip();
    zip.addLocalFolder(path);
    let zipped = zip.toBuffer();
    const s = p.spinner()
    s.start(`Calculating checksum`);
    checksum = await getChecksum(zipped, 'crc32');
    s.stop(`Checksum: ${checksum}`);
    if (key || existsSync(baseKeyPub)) {
      const publicKey = typeof key === 'string' ? key : baseKeyPub
      let keyData = ''
      // check if publicKey exist
      if (!existsSync(publicKey)) {
        p.log.error(`Cannot find public key ${publicKey}`);
        if (ciDetect()) {
          program.error('');
        }
        const res = await p.confirm({ message: 'Do you want to use our public key ?' })
        if (!res) {
          p.log.error(`Error: Missing public key`);
          program.error('');
        }
        keyData = defaulPublicKey
      }
      await snag.publish({
        channel: 'app',
        event: 'App encryption',
        icon: '🔑',
        tags: {
          'user-id': userId,
          'app-id': appid,
        },
        notify: false,
      }).catch()
      // open with fs publicKey path
      const keyFile = readFileSync(publicKey)
      keyData = keyFile.toString()
      // encrypt
      p.log.info(`Encrypting your bundle`);
      const res = encryptSource(zipped, keyData)
      sessionKey = res.ivSessionKey
      if (displayIvSession) {
        p.log.info(`Your Iv Session key is ${sessionKey},
keep it safe, you will need it to decrypt your bundle.
It will be also visible in your dashboard\n`);
      }
      zipped = res.encryptedData
    }
    const mbSize = Math.floor(zipped.byteLength / 1024 / 1024);
    const filePath = `apps/${userId}/${appid}/versions`
    if (mbSize > alertMb) {
      p.log.warn(`WARNING !!\nThe app size is ${mbSize} Mb, this may take a while to download for users\n`);
      p.log.info(`Learn how to optimize your assets https://capgo.app/blog/optimise-your-images-for-updates/\n`);
      await snag.publish({
        channel: 'app-error',
        event: 'App Too Large',
        icon: '🚛',
        tags: {
          'user-id': userId,
          'app-id': appid,
        },
        notify: false,
      }).catch()
    }

    const spinner = p.spinner();
    spinner.start(`Uploading Bundle`);
    const { error: upError } = await supabase.storage
      .from(filePath)
      .upload(fileName, zipped, {
        contentType: 'application/zip',
        cacheControl: '2592000',
      })
    spinner.stop('Bundle Uploaded 💪')
    if (upError) {
      p.log.error(`Cannot upload ${formatError(upError)}`);
      program.error('');
    }
  } else if (external && !external.startsWith('https://')) {
    p.log.error(`External link should should start with "https://" current is "${external}"`);
    program.error('');
  } else {
    await snag.publish({
      channel: 'app',
      event: 'App external',
      icon: '📤',
      tags: {
        'user-id': userId,
        'app-id': appid,
      },
      notify: false,
    }).catch()
  }
  const { error: dbError } = await updateOrCreateVersion(supabase, {
    bucket_id: external ? undefined : fileName,
    user_id: userId,
    name: bundle,
    app_id: appid,
    session_key: sessionKey,
    external_url: external,
    checksum,
  }, apikey)
  if (dbError) {
    p.log.error(`Cannot add bundle ${formatError(dbError)}`);
    program.error('');
  }
  const { data: versionId } = await supabase
    .rpc('get_app_versions', { apikey, name_version: bundle, appid })
    .single()
  if (versionId) {
    const { error: dbError3, data } = await updateOrCreateChannel(supabase, {
      name: channel,
      app_id: appid,
      created_by: userId,
      version: versionId,
    }, apikey)
    if (dbError3) {
      p.log.warn(`Cannot set channel, the upload key is not allowed to do that, use the "all" for this.`);
    }
    const appidWeb = convertAppName(appid)
    if (data?.public) {
      p.log.info('Your update is now available in your public channel 🎉')
    } else if (data?.id) {
      p.log.info(`Link device to this bundle to try it: ${hostWeb}/app/p/${appidWeb}/channel/${data.id}`);
    }
  } else {
    p.log.warn('Cannot set bundle with upload key, use key with more rights for that');
    program.error('');
  }
  await snag.publish({
    channel: 'app',
    event: 'App Uploaded',
    icon: '⏫',
    tags: {
      'user-id': userId,
      'app-id': appid,
    },
    notify: false,
  }).catch()
  if (shouldExit) {
    p.outro('Time to share your update to the world 🌍')
    process.exit()
  }
  return true
}

export const uploadCommand = async (apikey: string, options: Options) => {
  uploadBundle(apikey, options, true)
}

export const uploadDeprecatedCommand = async (apikey: string, options: Options) => {
  p.log.warn('⚠️  This command is deprecated, use "npx @capgo/cli bundle upload" instead ⚠️')
  uploadBundle(apikey, options, true)
}