// services/ChatService.js
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { GrpcAppError } = require('../errors/grpc');

class ChatService {
  constructor() {
    this.rooms = new Map();
  }

  async validateToken(source) {
    const jwtSecret = 'secret';
    let token = null;

    const auth = source?.metadata?.get?.('authorization')?.[0];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);

    if (!token && source?.request?.token) token = source.request.token;

    if (!token) throw GrpcAppError.unauthenticated('Token ausente');
    try {
      return jwt.verify(token, jwtSecret); // { id, email, username, ... }
    } catch {
      throw GrpcAppError.unauthenticated('Token inválido');
    }
  }

  _ensureRoom(room) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    return this.rooms.get(room);
  }

  _broadcast(room, message, exceptCall = null) {
    const set = this.rooms.get(room);
    if (!set) return;
    for (const c of set) {
      if (c === exceptCall) continue;
      try { c.write(message); } catch (_) {}
    }
  }

  Chat(call) {
    let joinedRoom = null;
    let user = null;

    const safeEnd = () => {
      try { call.end(); } catch (_) {}
    };

    const leaveRoom = () => {
      if (joinedRoom && this.rooms.has(joinedRoom)) {
        const set = this.rooms.get(joinedRoom);
        set.delete(call);
        if (set.size === 0) this.rooms.delete(joinedRoom);

        const leaveMsg = {
          room: joinedRoom,
          text: `${user?.username || 'alguém'} saiu da sala`,
          sender_id: user?.id || '',
          sender_name: user?.username || '',
          timestamp: Math.floor(Date.now() / 1000),
          type: 2,
        };
        this._broadcast(joinedRoom, leaveMsg, null);
      }
      joinedRoom = null;
    };

    call.on('data', async (msg) => {
      try {
        if (!user) user = await this.validateToken(call);

        const room = (msg.room || '').trim();
        if (!room) throw GrpcAppError.invalidArgument('room é obrigatório', { field: 'room' });

        if (!joinedRoom) {
          joinedRoom = room;
          const set = this._ensureRoom(room);
          set.add(call);

          const joinMsg = {
            room,
            text: `${user.username} entrou na sala`,
            sender_id: user.id,
            sender_name: user.username,
            timestamp: Math.floor(Date.now() / 1000),
            type: 1, 
          };
          this._broadcast(room, joinMsg, null);

          call.write({
            room,
            text: `Bem-vindo à sala ${room}!`,
            sender_id: 'system',
            sender_name: 'system',
            timestamp: Math.floor(Date.now() / 1000),
            type: 3, 
          });
        }

        if (msg.text && msg.text.trim()) {
          const out = {
            room: joinedRoom,
            text: msg.text.trim(),
            sender_id: user.id,
            sender_name: user.username,
            timestamp: Math.floor(Date.now() / 1000),
            type: 0, 
          };
          this._broadcast(joinedRoom, out, null);
        }
      } catch (err) {
        call.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });

    call.on('end', () => {
      leaveRoom();
      safeEnd();
    });

    call.on('cancelled', () => {
      leaveRoom();
      safeEnd();
    });

    call.on('error', () => {
      leaveRoom();
      safeEnd();
    });
  }
}

module.exports = ChatService;
