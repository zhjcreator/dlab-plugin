#!/usr/bin/env node
/**
 * dsh-lab CLI entry — delegates to lib/cli.js runCli.
 */

import { runCli } from '../lib/cli.js'

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
