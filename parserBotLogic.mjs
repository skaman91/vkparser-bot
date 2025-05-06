import TelegramBot from 'node-telegram-bot-api'
import 'dotenv/config'
import { MongoClient } from 'mongodb'
import { commands, jobGroup, targetGroups } from './const.js'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

const MONGO_URL = process.env.MONGO_URL
const client = new MongoClient(MONGO_URL)
await client.connect()
console.log('Connected successfully to db')
const db = client.db('parser-bot')
const userCollection = db.collection('users')
const stateCollection = db.collection('state')

const usersMap = {}

export default class BotLogic {
  constructor ({
    apiToken
  }) {
    this.apiToken = apiToken
    this.bot = null
  }

  async start () {
    if (!this.bot) {
      this.bot = new TelegramBot(this.apiToken, { polling: true })
      console.log('parser-bot started')
      await this.bot.setMyCommands(commands)
      this.bot.on('message', msg => this.onMessage(msg))
      this.bot.on('channel_post', msg => this.onChannelPost(msg))
      this.bot.on('photo', msg => this.onFile(msg))
      // this.bot.on('callback_query', msg => this.onCallback(msg))
      setInterval(() => this.parseAndPostToMyGroup(), 30 * 60 * 1000) // парсим каждый час
    }
  }

  async onChannelPost (msg) {
    console.log('msg', msg)
  }

  async onMessage (msg) {
    try {
      if (msg.text) {
        console.log('Сообщение:', msg.text, 'userName:', msg?.from.username ? `@${msg?.from.username}` : '', 'first_name:', msg?.from.first_name, 'id:' + msg?.from.id)
        const profile = await userCollection.findOne({ id: msg.from.id })

        if (profile) {
          if (!profile.active) {
            await this.bot.sendMessage(msg.from.id, 'Ваш профиль еще не одобрен')
            return
          }

          if (profile.banned) {
            await this.bot.sendMessage(msg.from.id, 'Ваш профиль заблокирован, вы не можете пользоваться ботом')
          }
        }

        if (msg.text === '/start') {
          if (!profile) {
            await this.registration(msg)
            return
          }

          if (profile) {
            await this.bot.sendMessage(msg.from.id, 'Вы уже зарегистрированы')
            return
          }
        }

        const chatId = msg.chat?.id
        const user = msg?.from.first_name
        const userName = msg?.from.username ? `@${msg?.from.username}` : ''
        const userId = msg?.from.id

        if (!usersMap[chatId]) {
          usersMap[chatId] = {
            username: userName,
            firstName: user,
            userId,
            step: 0,
            photo: '',
            groupId: '',
            token: profile.token,
            group_parsing: false
          }
        }

        if (msg.text === '/group_parsing') {
          if (!usersMap[chatId].token) {
            await this.bot.sendMessage(msg.from.id, 'Перейди по <a href="https://oauth.vk.com/authorize?client_id=6121396&scope=offline&redirect_uri=https://oauth.vk.com/blank.html&display=page&response_type=token&revoke=1">ссылке</a>, предоставь разрешения и отправь мне получившуюся ссылку из адресной строки.', { parse_mode: 'HTML' })
            return
          }
          usersMap[chatId].step = 1
          await this.bot.sendMessage(chatId, 'Введите ID группы ВКонтакте, например: "public123456" или "club78910"')
          return
        }

        const step = usersMap[chatId]?.step || 0
        // STEP 1 — ожидаем ID группы
        if (step === 1) {
          usersMap[chatId].groupId = msg.text.trim()
          usersMap[chatId].step = 2
          await this.bot.sendMessage(chatId, 'Сколько постов нужно спарсить? Введите число до 100')
          return
        }

        // STEP 2 — ожидаем количество постов
        if (step === 2) {
          const count = parseInt(msg.text.trim(), 10)
          if (isNaN(count) || count <= 0) {
            await this.bot.sendMessage(chatId, 'Введите корректное положительное число до 100')
            return
          }

          usersMap[chatId].postCount = count
          usersMap[chatId].step = 0 // Сброс после сбора параметров

          // Вызываем метод парсинга (заготовка)
          await this.bot.sendMessage(chatId, `Парсим ${count} постов из группы ${usersMap[chatId].groupId}...`)
          await this.getGroupPosts(chatId, usersMap[chatId].groupId, count)
          return
        }

        if (/access/i.test(msg.text)) {
          const regex = /access_token=([^&]+)/
          const match = msg.text.match(regex)

          if (match) {
            const accessToken = match[1]
            console.log('Access Token:', accessToken)
            usersMap[chatId].token = accessToken
            await userCollection.updateOne({ id: userId }, { $set: { 'token': accessToken } })
            await this.bot.sendMessage(chatId, 'Ваш токен обновлен')
          } else {
            console.log('Access Token not found')
          }
        }

        if (/сделать пост/i.test(msg.text)) {
          const text = msg.text.split('|')[1].trim()
          await this.postToGroup(text, chatId)
        }
      }
    } catch (e) {
      console.log('Failed onMessage', e.message)
    }
  }

  async postToGroup (text, chatId) {
    try {
      const res = await axios.post('https://api.vk.com/method/wall.post', null, {
        params: {
          owner_id: jobGroup,
          from_group: 1,
          message: text,
          access_token: usersMap[chatId].token,
          v: '5.199'
        }
      })

      console.log('✅ Ответ:', JSON.stringify(res.data, null, 2))

      console.log('✅ Пост опубликован:', res.data.response)
    } catch (e) {
      console.error('❌ Ошибка при публикации:', e.response?.data || e.message)
    }
  }

  async getGroupPosts(chatId, GROUP_DOMAIN, count) {
    try {
      const API_VERSION = '5.199'
      const ACCESS_TOKEN = usersMap[chatId]?.token

      if (!ACCESS_TOKEN) {
        await this.bot.sendMessage(chatId, '❗️ Токен не найден. Пожалуйста, авторизуйтесь сначала.')
        return
      }

      const response = await axios.get('https://api.vk.com/method/wall.get', {
        params: {
          access_token: ACCESS_TOKEN,
          v: API_VERSION,
          domain: GROUP_DOMAIN,
          count
        }
      })

      const items = response.data.response.items

      if (!items.length) {
        await this.bot.sendMessage(chatId, '😕 Посты не найдены.')
        return
      }

      let output = `🧾 Последние ${items.length} постов из группы ${GROUP_DOMAIN}:\n\n`

      for (const post of items) {
        output += `🕒 Дата: ${new Date(post.date * 1000).toLocaleString()}\n`
        output += `📄 Текст: ${post.text.slice(0, 1000)}\n`
        output += '---\n\n'
      }

      const fileName = `group_${GROUP_DOMAIN}_${Date.now()}.txt`
      const filePath = path.join('/tmp', fileName) // кроссплатформенная временная папка

      fs.writeFileSync(filePath, output)

      await this.bot.sendDocument(chatId, filePath, {}, {
        filename: fileName,
        contentType: 'text/plain'
      })

      fs.unlinkSync(filePath) // удалить файл после отправки
    } catch (error) {
      console.error('❌ Ошибка при получении постов:', error.response?.data || error.message)
      await this.bot.sendMessage(chatId, 'Произошла ошибка при получении постов.')
    }
  }


  async onFile (msg) {
    try {

    } catch (e) {
      console.log('Failed onFile', e.message)
    }
  }

  delay (minDelay, maxDelay) {
    const timeout = maxDelay ? ~~((minDelay + (maxDelay - minDelay) * Math.random())) : minDelay

    return new Promise(resolve => setTimeout(resolve, timeout))
  }

  async registration (msg) {
    try {
      if (/^\/start$/i.test(msg.text)) {
        const chatId = msg.from.id
        const text = `Привет. Это бот парсер и он пока в разработке. Посмотри доступные команды в меню. Бот в тестовом режиме, использование возможно только после одобрения админом вашего профиля`
        await this.bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
        const username = msg.from.username
        const firstName = msg.from.first_name
        const id = msg.from.id
        const profile = await userCollection.findOne({ id: id })
        if (!profile) {
          await userCollection.insertOne({
            id: id,
            firstName: firstName,
            username: username,
            banned: false,
            active: false,
            token: '',
            balance: 0
          })
          await this.bot.sendMessage(139280481, `<b>В боте новый пользователь\nusername: ${username}\nfirstName ${firstName}\nid: ${id}\n требуется подтверждение</b>`, { parse_mode: 'HTML' })
        }
      }
    } catch (e) {
      console.log('Failed registration', e.message)
    }
  }

  // получить из базы id последнего спашенного поста
  async getLastPostId(group) {
    const state = await stateCollection.findOne({ group })
    return state?.lastPostId || 0
  }

  // записать в базу новый id последнего поста
  async setLastPostId(group, postId) {
    await stateCollection.updateOne(
      { group },
      { $set: { lastPostId: postId } },
      { upsert: true }
    )
  }

  async parseAndPostToMyGroup () {
    console.log('🚀 Начинаем автоматический парсинг и публикацию')
    const jobToken = process.env.TOKEN_VK_API // токен для публикации

    for (const group of targetGroups) {
      try {
        const response = await axios.get('https://api.vk.com/method/wall.get', {
          params: {
            access_token: jobToken,
            v: '5.199',
            domain: group.domain,
            count: 20
          }
        })

        const items = response.data.response.items
        if (!items.length) continue

        const lastSavedId = await this.getLastPostId(group.domain)

        const blacklist = ['такси', 'скидка', 'купон', 'промокод']

        for (const post of items.reverse()) { // от старого к новому
          const text = post.text?.trim()

          // Пропустить, если текста нет или он пустой
          if (!text) continue

          // Пропустить, если текст содержит одно из "запрещённых" слов
          const lowerText = text.toLowerCase()
          if (blacklist.some(word => lowerText.includes(word))) {
            console.log(`⛔ Пропущен пост ID ${post.id} — содержит запрещённые слова. Текст поста: ${text}`)
            continue
          }

          if (post.id > lastSavedId) {
            await axios.post('https://api.vk.com/method/wall.post', null, {
              params: {
                owner_id: jobGroup,
                from_group: 1,
                message: text,
                access_token: jobToken,
                v: '5.199'
              }
            })
            console.log(`✅ Опубликован пост ID ${post.id} из ${group.domain}`)
            await this.setLastPostId(group.domain, post.id)
            await this.delay(15000) // между постами ждем 15 сек
          }
        }

      } catch (e) {
        console.error(`❌ Ошибка при публикации из ${group.domain}:`, e.response?.data || e.message)
      }
    }
  }


  stop () {
    if (this.bot) {
      this.bot.stop()
    }
  }
}