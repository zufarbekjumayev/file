const express = require("express")
const WebSocket = require("ws")
const cors = require("cors")
const { createClient } = require("redis")

const app = express()

// CORS sozlamalari
app.use(
  cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"],
  }),
)

// Redis ulanish
const redisClient = createClient({
  url: "rediss://default:AU2HAAIjcDFhNzBmNGRkNTM4MDI0OTEyOWM3NzI3OWZkMGY3YzE0MXAxMA@suited-hawk-19847.upstash.io:6379",
})

redisClient.on("error", (err) => console.error("Redis Client Error:", err))

// Redisga ulanish
redisClient.connect().catch(console.error)

const connectedClients = new Set()
let redisTaskStarted = false

// WebSocket serverini yaratish
const wss = new WebSocket.Server({ port: 8080 })

async function broadcastRedisMessages() {
  const subscriber = redisClient.duplicate()
  await subscriber.connect()
  await subscriber.subscribe("chat", (message) => {
    connectedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message)
        } catch (err) {
          console.error("Broadcast error:", err)
          connectedClients.delete(client)
        }
      }
    })
  })
}

wss.on("connection", (ws) => {
  connectedClients.add(ws)

  // Redis listenerni faqat bir marta ishga tushirish
  if (!redisTaskStarted) {
    broadcastRedisMessages().catch((err) => console.error("Redis listener error:", err))
    redisTaskStarted = true
  }

  ws.on("message", async (data) => {
    try {
      const message = data.toString("utf8")
      await redisClient.publish("chat", message)
    } catch (err) {
      console.error("WebSocket message error:", err)
    }
  })

  ws.on("close", () => {
    connectedClients.delete(ws)
  })

  ws.on("error", (err) => {
    console.error("WebSocket error:", err)
    connectedClients.delete(ws)
  })
})

// Express serverini ishga tushirish
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
