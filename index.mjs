import BotLogic from './parserBotLogic.mjs'
import 'dotenv/config'

const botStart = new BotLogic ({
  apiToken: process.env.BOT_TOKEN
})

function shutdown () {
  try {
    botStart.stop()
    process.exit(0)
  } catch (err) {
    process.exit(1)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  console.log('Starting')
  await botStart.start()
} catch (e) {
  console.log('Start failed:', e.message)
  await shutdown()
}