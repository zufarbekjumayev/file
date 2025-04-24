const express = require("express")
const WebSocket = require("ws")
const cors = require("cors")
const { createClient } = require("redis")
const path = require("path")
const fs = require("fs")

const app = express()

// Serve static files
app.use(express.static(path.join(__dirname, ".")))

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
const activeUsers = new Set()
let redisTaskStarted = false

// WebSocket serverini yaratish
const wss = new WebSocket.Server({ noServer: true })

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

async function broadcastUserCount() {
  setInterval(async () => {
    try {
      const countMessage = JSON.stringify({
        type: "userCount",
        count: activeUsers.size,
        timestamp: new Date().toISOString(),
      })
      await redisClient.publish("chat", countMessage)
    } catch (err) {
      console.error("User count broadcast error:", err)
    }
  }, 10000) // Update every 10 seconds
}

wss.on("connection", (ws) => {
  connectedClients.add(ws)
  let username = null

  // Redis listenerni faqat bir marta ishga tushirish
  if (!redisTaskStarted) {
    broadcastRedisMessages().catch((err) => console.error("Redis listener error:", err))
    broadcastUserCount().catch((err) => console.error("User count broadcast error:", err))
    redisTaskStarted = true
  }

  ws.on("message", async (data) => {
    try {
      const messageStr = data.toString("utf8")
      let messageData

      try {
        // Try to parse as JSON
        messageData = JSON.parse(messageStr)

        // Extract username if present
        if (messageData.username && !username) {
          username = messageData.username
          activeUsers.add(username)
        }

        // Ensure timestamp is present
        if (!messageData.timestamp) {
          messageData.timestamp = new Date().toISOString()
        }

        // Convert back to string for Redis
        await redisClient.publish("chat", JSON.stringify(messageData))
      } catch (parseErr) {
        // If not JSON, wrap in a simple message format
        messageData = {
          content: messageStr,
          timestamp: new Date().toISOString(),
          username: "Anonymous",
        }
        await redisClient.publish("chat", JSON.stringify(messageData))
      }
    } catch (err) {
      console.error("WebSocket message error:", err)
    }
  })

  ws.on("close", async () => {
    connectedClients.delete(ws)
    if (username) {
      activeUsers.delete(username)
      // Notify others that user has left
      const leaveMessage = JSON.stringify({
        type: "system",
        content: `${username} has left the chat`,
        timestamp: new Date().toISOString(),
      })
      await redisClient.publish("chat", leaveMessage)
    }
  })

  ws.on("error", (err) => {
    console.error("WebSocket error:", err)
    connectedClients.delete(ws)
    if (username) {
      activeUsers.delete(username)
    }
  })
})

// Serve index.html for the root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

// Express serverini ishga tushirish
const PORT = process.env.PORT || 3000
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

// Upgrade HTTP server to WebSocket
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request)
  })
})
