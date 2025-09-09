const grpc = require('@grpc/grpc-js');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const Task = require('../models/Task');
const database = require('../database/database');
const ProtoLoader = require('../utils/protoLoader');
const { GrpcAppError, toServiceError } = require('../errors/grpc');

class TaskService {
    constructor() {
        this.streamingSessions = new Map(); // Para gerenciar streams ativos
    }

    /**
     * Middleware para validação de token
     */
    async validateToken(token) {
        const jwtSecret = 'secret';
        try {
            return jwt.verify(token, jwtSecret);
        } catch (e) {
            throw GrpcAppError.unauthenticated('Token inválido');
        }
    }
    /**
     * Criar tarefa
     */
    async createTask(call, callback) {
        try {
            const { token, title, description, priority } = call.request;

            const user = await this.validateToken(token);

            if (!title || !title.trim()) {
                throw GrpcAppError.invalidArgument('Título é obrigatório', { field: 'title' });
            }

            const taskData = {
                id: uuidv4(),
                title: title.trim(),
                description: description || '',
                priority: ProtoLoader.convertFromPriority(priority),
                userId: user.id,
                completed: false
            };

            const task = new Task(taskData);
            const validation = task.validate();
            if (!validation.isValid) {
                throw GrpcAppError.invalidArgument('Dados inválidos', validation.errors);
            }

            await database.run(
                'INSERT INTO tasks (id, title, description, priority, userId) VALUES (?, ?, ?, ?, ?)',
                [task.id, task.title, task.description, task.priority, task.userId]
            );

            this.notifyStreams('TASK_CREATED', task);

            callback(null, {
                success: true,
                message: 'Tarefa criada com sucesso',
                task: task.toProtobuf()
            });
        } catch (err) {
            console.error('createTask:', err);
            callback(toServiceError(err));
        }
    }


    /**
     * Listar tarefas com paginação
     */
    async getTasks(call, callback) {
        try {
            const { token, completed, priority } = call.request;
            let { page, limit } = call.request;

            const user = await this.validateToken(token);

            page = page ? parseInt(page, 10) : 1;
            limit = limit ? parseInt(limit, 10) : 10;
            if (!Number.isFinite(page) || page < 1) {
                throw GrpcAppError.invalidArgument('page deve ser >= 1', { field: 'page' });
            }
            if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
                throw GrpcAppError.invalidArgument('limit deve estar entre 1 e 100', { field: 'limit' });
            }

            let sql = 'SELECT * FROM tasks WHERE userId = ?';
            const params = [user.id];

            if (completed !== undefined && completed !== null) {
                sql += ' AND completed = ?';
                params.push(completed ? 1 : 0);
            }
            if (priority !== undefined && priority !== null) {
                sql += ' AND priority = ?';
                params.push(ProtoLoader.convertFromPriority(priority));
            }
            sql += ' ORDER BY createdAt DESC';

            const result = await database.getAllWithPagination(sql, params, page, limit);
            const tasks = result.rows.map(row =>
                new Task({ ...row, completed: row.completed === 1 }).toProtobuf()
            );

            callback(null, { success: true, tasks, total: result.total, page: result.page, limit: result.limit });
        } catch (err) {
            console.error('getTasks:', err);
            callback(toServiceError(err));
        }
    }

    /**
     * Buscar tarefa específica
     */
    async getTask(call, callback) {
        try {
            const { token, task_id } = call.request;
            const user = await this.validateToken(token);

            const row = await database.get(
                'SELECT * FROM tasks WHERE id = ? AND userId = ?',
                [task_id, user.id]
            );
            if (!row) throw GrpcAppError.notFound('Tarefa não encontrada', { task_id });

            const task = new Task({ ...row, completed: row.completed === 1 });
            callback(null, { success: true, message: 'Tarefa encontrada', task: task.toProtobuf() });
        } catch (err) {
            console.error('getTask:', err);
            callback(toServiceError(err));
        }
    }

    /**
     * Atualizar tarefa
     */
    async updateTask(call, callback) {
        try {
            const { token, task_id, title, description, completed, priority } = call.request;
            const user = await this.validateToken(token);

            const existing = await database.get(
                'SELECT * FROM tasks WHERE id = ? AND userId = ?',
                [task_id, user.id]
            );
            if (!existing) throw GrpcAppError.notFound('Tarefa não encontrada', { task_id });

            const updateData = {
                title: title ?? existing.title,
                description: description !== undefined ? description : existing.description,
                completed: completed !== undefined ? completed : (existing.completed === 1),
                priority: priority !== undefined ? ProtoLoader.convertFromPriority(priority) : existing.priority
            };

            const result = await database.run(
                'UPDATE tasks SET title = ?, description = ?, completed = ?, priority = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?',
                [updateData.title, updateData.description, updateData.completed ? 1 : 0, updateData.priority, task_id, user.id]
            );
            if (result.changes === 0) throw GrpcAppError.internal('Falha ao atualizar tarefa');

            const updated = await database.get('SELECT * FROM tasks WHERE id = ? AND userId = ?', [task_id, user.id]);
            const task = new Task({ ...updated, completed: updated.completed === 1 });

            this.notifyStreams('TASK_UPDATED', task);
            callback(null, { success: true, message: 'Tarefa atualizada com sucesso', task: task.toProtobuf() });
        } catch (err) {
            console.error('updateTask:', err);
            callback(toServiceError(err));
        }
    }

    /**
     * Deletar tarefa
     */
    async deleteTask(call, callback) {
        try {
            const { token, task_id } = call.request;
            const user = await this.validateToken(token);

            const existing = await database.get('SELECT * FROM tasks WHERE id = ? AND userId = ?', [task_id, user.id]);
            if (!existing) throw GrpcAppError.notFound('Tarefa não encontrada', { task_id });

            const result = await database.run('DELETE FROM tasks WHERE id = ? AND userId = ?', [task_id, user.id]);
            if (result.changes === 0) throw GrpcAppError.internal('Falha ao deletar tarefa');

            const task = new Task({ ...existing, completed: existing.completed === 1 });
            this.notifyStreams('TASK_DELETED', task);

            callback(null, { success: true, message: 'Tarefa deletada com sucesso' });
        } catch (err) {
            console.error('deleteTask:', err);
            callback(toServiceError(err));
        }
    }

    /**
     * Estatísticas das tarefas
     */
    async getTaskStats(call, callback) {
        try {
            const { token } = call.request;
            const user = await this.validateToken(call.request.token);
            ;

            const stats = await database.get(`
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) as pending
                FROM tasks WHERE userId = ?
            `, [user.id]);

            const completionRate = stats.total > 0 ? ((stats.completed / stats.total) * 100) : 0;

            callback(null, {
                success: true,
                stats: {
                    total: stats.total,
                    completed: stats.completed,
                    pending: stats.pending,
                    completion_rate: parseFloat(completionRate.toFixed(2))
                }
            });
        } catch (error) {
            console.error('Task:', error);
            callback(toServiceError(error));
        }
    }

    /**
     * Stream de tarefas (Server Streaming)
     * 
     * Demonstra como o gRPC permite streaming de dados,
     * possibilitando atualizações em tempo real
     */
    async streamTasks(call) {
        try {
            const { token, completed } = call.request;
            const user = await this.validateToken(call.request.token);
            ;

            let sql = 'SELECT * FROM tasks WHERE userId = ?';
            const params = [user.id];

            if (completed !== undefined && completed !== null) {
                sql += ' AND completed = ?';
                params.push(completed ? 1 : 0);
            }

            sql += ' ORDER BY createdAt DESC';

            const rows = await database.all(sql, params);

            // Enviar tarefas existentes
            for (const row of rows) {
                const task = new Task({ ...row, completed: row.completed === 1 });
                call.write(task.toProtobuf());

                // Simular delay para demonstrar streaming
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Manter stream aberto para futuras atualizações
            const sessionId = uuidv4();
            this.streamingSessions.set(sessionId, {
                call,
                userId: user.id,
                filter: { completed }
            });

            call.on('cancelled', () => {
                this.streamingSessions.delete(sessionId);
                console.log(`Stream cancelado: ${sessionId}`);
            });

        } catch (error) {
            console.error('Erro no stream de tarefas:', error);
            call.destroy(new Error(error.message || 'Erro no streaming'));
        }
    }

    /**
     * Stream de notificações (Server Streaming)
     * 
     * Envia notificações em tempo real sobre mudanças nas tarefas
     */
    async streamNotifications(call) {
        try {
            const { token } = call.request;
            const user = await this.validateToken(call.request.token);
            ;

            const sessionId = uuidv4();

            this.streamingSessions.set(sessionId, {
                call,
                userId: user.id,
                type: 'notifications'
            });

            // Enviar mensagem inicial
            call.write({
                type: 0, // TASK_CREATED
                message: 'Stream de notificações iniciado',
                timestamp: Math.floor(Date.now() / 1000),
                task: null
            });

            call.on('cancelled', () => {
                this.streamingSessions.delete(sessionId);
                console.log(`Stream de notificações cancelado: ${sessionId}`);
            });

            call.on('error', (error) => {
                console.error('Erro no stream de notificações:', error);
                this.streamingSessions.delete(sessionId);
            });

        } catch (error) {
            console.error('Erro ao iniciar stream de notificações:', error);
            call.destroy(new Error(error.message || 'Erro no streaming'));
        }
    }

    /**
     * Notificar todos os streams ativos sobre mudanças
     */
    notifyStreams(action, task) {
        const notificationTypeMap = {
            'TASK_CREATED': 0,
            'TASK_UPDATED': 1,
            'TASK_DELETED': 2,
            'TASK_COMPLETED': 3
        };

        for (const [sessionId, session] of this.streamingSessions.entries()) {
            try {
                if (session.userId === task.userId) {
                    if (session.type === 'notifications') {
                        // Stream de notificações
                        session.call.write({
                            type: notificationTypeMap[action],
                            task: task.toProtobuf(),
                            message: `Tarefa ${action.toLowerCase().replace('_', ' ')}`,
                            timestamp: Math.floor(Date.now() / 1000)
                        });
                    } else if (session.filter) {
                        // Stream de tarefas com filtro
                        const { completed } = session.filter;
                        if (completed === undefined || completed === task.completed) {
                            if (action !== 'TASK_DELETED') {
                                session.call.write(task.toProtobuf());
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`Erro ao notificar stream ${sessionId}:`, error);
                this.streamingSessions.delete(sessionId);
            }
        }
    }
}

module.exports = TaskService;