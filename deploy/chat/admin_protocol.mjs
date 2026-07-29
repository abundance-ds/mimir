#!/usr/bin/env node
/**
 * Exercise the live Mimir Chat administration lifecycle without printing
 * tokens or generated teammate passphrases.
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const options = { base: 'https://chat.shoulde.rs/admin/' }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || !['--base', '--token-file'].includes(flag)) {
      throw new Error(`unknown or incomplete argument: ${flag ?? ''}`)
    }
    if (flag === '--base') options.base = value
    else options.tokenFile = value
  }
  if (!options.tokenFile) throw new Error('--token-file is required')
  options.base = options.base.endsWith('/') ? options.base : `${options.base}/`
  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const token = (await readFile(options.tokenFile, 'utf8')).trim()
  if (token.length < 32 || /\s/.test(token)) throw new Error('token file is invalid')
  const suffix = randomBytes(4).toString('hex')
  const account = `mimircheck-${suffix}`
  const channel = `#mimircheck-${suffix}`

  const api = async (path, body) => {
    const response = await fetch(new URL(`api/${path}`, options.base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value = await response.json().catch(() => null)
    if (!response.ok || !value?.ok) {
      throw new Error(value?.error || `administration request failed (${response.status})`)
    }
    return value.result
  }

  const state = () => api('state')
  const post = (path, body = {}) => api(path, body)
  let failure

  try {
    await state()
    console.log('state read')

    const created = await post('users', { account })
    if (created.account !== account || !created.passphrase) throw new Error('user creation result was incomplete')
    console.log('user added')

    const reset = await post(`users/${encodeURIComponent(account)}/password`)
    if (!reset.passphrase || reset.passphrase === created.passphrase) {
      throw new Error('passphrase reset did not rotate the credential')
    }
    console.log('passphrase reset')

    await post(`users/${encodeURIComponent(account)}/deactivate`)
    if ((await state()).users.find(user => user.account === account)?.active !== false) {
      throw new Error('deactivated user was not reported inactive')
    }
    console.log('user access removed')

    await post(`users/${encodeURIComponent(account)}/reactivate`)
    if ((await state()).users.find(user => user.account === account)?.active !== true) {
      throw new Error('reactivated user was not reported active')
    }
    console.log('user access restored')

    await post('channels', { name: channel, topic: 'Administration lifecycle check', founder: 'waqr' })
    if (!(await state()).channels.some(candidate => candidate.name === channel)) {
      throw new Error('created channel was not listed')
    }
    console.log('channel created')

    await post(`channels/${encodeURIComponent(channel)}/topic`, {
      topic: 'Administration lifecycle check updated',
    })
    console.log('channel topic updated')

    await post(`channels/${encodeURIComponent(channel)}/transfer`, { founder: account })
    if ((await state()).channels.find(candidate => candidate.name === channel)?.founder !== account) {
      throw new Error('transferred channel founder was not updated')
    }
    console.log('channel ownership transferred')

    await post(`channels/${encodeURIComponent(channel)}/retire`)
    if (!(await state()).retiredChannels.includes(channel)) {
      throw new Error('retired channel was not listed')
    }
    console.log('channel retired')

    await post(`channels/${encodeURIComponent(channel)}/allow`)
    if ((await state()).retiredChannels.includes(channel)) {
      throw new Error('allowed channel name remained retired')
    }
    console.log('channel name allowed')

    await post(`users/${encodeURIComponent(account)}/delete`)
    if ((await state()).users.some(user => user.account === account)) {
      throw new Error('deleted user remained listed')
    }
    console.log('user deleted')
  } catch (error) {
    failure = error
  } finally {
    try {
      const current = await state()
      if (current.channels.some(candidate => candidate.name === channel)) {
        await post(`channels/${encodeURIComponent(channel)}/retire`)
      }
      if ((await state()).retiredChannels.includes(channel)) {
        await post(`channels/${encodeURIComponent(channel)}/allow`)
      }
      const user = (await state()).users.find(candidate => candidate.account === account)
      if (user && !user.active) await post(`users/${encodeURIComponent(account)}/reactivate`)
      if ((await state()).users.some(candidate => candidate.account === account)) {
        await post(`users/${encodeURIComponent(account)}/delete`)
      }
    } catch (cleanupError) {
      failure ??= new Error(`cleanup failed: ${cleanupError.message}`)
    }
  }

  if (failure) throw failure
  console.log('Mimir Chat administration lifecycle healthy')
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
