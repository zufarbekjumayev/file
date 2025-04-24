from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import redis.asyncio as redis
import asyncio
import json
from datetime import datetime
import os
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# CORS sozlamalari
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Redisga ulanish
try:
    redis_client = redis.Redis(
        host="suited-hawk-19847.upstash.io",
        port=6379,
        password="AU2HAAIjcDFhNzBmNGRkNTM4MDI0OTEyOWM3NzI3OWZkMGY3YzE0MXAxMA",
        ssl=True,
        decode_responses=True  # Automatically decode responses to strings
    )
    logger.info("Redis connection established")
except Exception as e:
    logger.error(f"Redis connection error: {e}")
    # Create a dummy redis client for development if Redis fails
    class DummyRedis:
        async def publish(self, channel, message):
            logger.info(f"Would publish to {channel}: {message}")
            return 1
        
        def pubsub(self):
            return DummyPubSub()
    
    class DummyPubSub:
        async def subscribe(self, channel):
            logger.info(f"Would subscribe to {channel}")
            return None
            
        async def get_message(self, ignore_subscribe_messages=True, timeout=1.0):
            await asyncio.sleep(1)
            return None
    
    redis_client = DummyRedis()
    logger.warning("Using dummy Redis client")

connected_clients = set()
active_users = set()
redis_task_started = False
background_tasks = set()

# Serve the index.html file at the root
@app.get("/")
async def get_index():
    return FileResponse("index.html")

async def broadcast_redis_messages():
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("chat")
    
    try:
        while True:
            try:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message:
                    data = message["data"] if isinstance(message["data"], str) else message["data"].decode()
                    await broadcast_to_clients(data)
            except Exception as e:
                logger.error(f"Redis listener error: {e}")
            await asyncio.sleep(0.01)  # Prevent CPU hogging
    except asyncio.CancelledError:
        logger.info("Redis broadcast task cancelled")
        raise
    except Exception as e:
        logger.error(f"Broadcast task error: {e}")

async def broadcast_to_clients(data):
    disconnected_clients = set()
    for client in connected_clients:
        try:
            await client.send_text(data)
        except Exception as e:
            logger.error(f"Failed to send to client: {e}")
            disconnected_clients.add(client)
    
    # Remove disconnected clients
    for client in disconnected_clients:
        connected_clients.remove(client)

async def broadcast_user_count():
    try:
        while True:
            try:
                count_message = json.dumps({
                    "type": "userCount",
                    "count": len(active_users),
                    "timestamp": datetime.now().isoformat()
                })
                await redis_client.publish("chat", count_message)
            except Exception as e:
                logger.error(f"User count broadcast error: {e}")
            await asyncio.sleep(10)  # Update every 10 seconds
    except asyncio.CancelledError:
        logger.info("User count task cancelled")
        raise
    except Exception as e:
        logger.error(f"User count task error: {e}")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global redis_task_started
    
    await websocket.accept()
    connected_clients.add(websocket)
    client_id = id(websocket)
    username = None
    
    # Start background tasks if not already running
    if not redis_task_started:
        # Create and store tasks
        redis_task = asyncio.create_task(broadcast_redis_messages())
        count_task = asyncio.create_task(broadcast_user_count())
        
        # Add to set to prevent garbage collection
        background_tasks.add(redis_task)
        background_tasks.add(count_task)
        
        # Set up task cleanup
        redis_task.add_done_callback(lambda t: background_tasks.remove(t))
        count_task.add_done_callback(lambda t: background_tasks.remove(t))
        
        redis_task_started = True
        logger.info("Background tasks started")

    try:
        while True:
            data = await websocket.receive_text()
            try:
                # Try to parse as JSON
                message_data = json.loads(data)
                
                # Extract username if present
                if "username" in message_data and username is None:
                    username = message_data["username"]
                    active_users.add(username)
                    logger.info(f"User {username} connected")
                
                # Ensure timestamp is present
                if "timestamp" not in message_data:
                    message_data["timestamp"] = datetime.now().isoformat()
                
                # Convert back to string for Redis
                data = json.dumps(message_data)
            except json.JSONDecodeError:
                # If not JSON, wrap in a simple message format
                data = json.dumps({
                    "content": data,
                    "timestamp": datetime.now().isoformat(),
                    "username": "Anonymous"
                })
            
            await redis_client.publish("chat", data)
    except WebSocketDisconnect:
        logger.info(f"Client disconnected: {client_id}")
        connected_clients.remove(websocket)
        if username:
            active_users.discard(username)
            # Notify others that user has left
            leave_message = json.dumps({
                "type": "system",
                "content": f"{username} has left the chat",
                "timestamp": datetime.now().isoformat()
            })
            await redis_client.publish("chat", leave_message)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        connected_clients.remove(websocket)
        if username:
            active_users.discard(username)

@app.on_event("shutdown")
async def shutdown_event():
    # Cancel all background tasks
    for task in background_tasks:
        task.cancel()
    
    # Wait for all tasks to complete
    if background_tasks:
        await asyncio.gather(*background_tasks, return_exceptions=True)
    
    logger.info("Application shutdown complete")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
# uvicorn main:app --reload

