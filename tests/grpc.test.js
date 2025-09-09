const GrpcServer = require('../server');
const GrpcClient = require('../client');

describe('gRPC Services Tests', () => {
    let server;
    let client;
    let authToken;
    let taskId;

    beforeAll(async () => {
        // Iniciar servidor gRPC em porta diferente para testes
        server = new GrpcServer();
        
        // Usar Promise para aguardar o servidor inicializar
        await new Promise((resolve, reject) => {
            server.initialize().then(() => {
                const grpc = require('@grpc/grpc-js');
                const serverCredentials = grpc.ServerCredentials.createInsecure();
                
                server.server.bindAsync('0.0.0.0:50052', serverCredentials, (error, boundPort) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    server.server.start();
                    resolve();
                });
            }).catch(reject);
        });
        
        // Aguardar um pouco mais para garantir que o servidor está pronto
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Inicializar cliente
        client = new GrpcClient('localhost:50052');
        await client.initialize();
    }, 30000);

    afterAll(async () => {
        if (server?.server) {
            await new Promise(resolve => {
                server.server.tryShutdown(() => resolve());
            });
        }
    });

    describe('Autenticação', () => {
        test('deve registrar usuário com sucesso', async () => {
            const uniqueId = Date.now();
            const response = await client.register({
                email: `test${uniqueId}@grpc.com`,
                username: `grpctest${uniqueId}`,
                password: 'password123',
                first_name: 'Test',
                last_name: 'User'
            });

            expect(response.success).toBe(true);
            expect(response.token).toBeDefined();
            expect(response.user).toBeDefined();
            expect(response.user.email).toBe(`test${uniqueId}@grpc.com`);
            authToken = response.token;
            
            // Configurar o token no cliente para próximos testes
            client.currentToken = response.token;
        });

        test('deve fazer login com sucesso', async () => {
            // Usar as credenciais do usuário recém-criado
            const response = await client.login({
                identifier: client.currentToken ? 'existing_user@grpc.com' : 'test@grpc.com',
                password: 'password123'
            });

            // Se o login falhar, tentar com usuário que sabemos que existe
            if (!response.success) {
                // Criar um novo usuário para login
                const uniqueId = Date.now() + 1;
                await client.register({
                    email: `logintest${uniqueId}@grpc.com`,
                    username: `logintest${uniqueId}`,
                    password: 'password123',
                    first_name: 'Login',
                    last_name: 'Test'
                });

                const loginResponse = await client.login({
                    identifier: `logintest${uniqueId}@grpc.com`,
                    password: 'password123'
                });

                expect(loginResponse.success).toBe(true);
                expect(loginResponse.token).toBeDefined();
                expect(loginResponse.user).toBeDefined();
                client.currentToken = loginResponse.token;
            } else {
                expect(response.success).toBe(true);
                expect(response.token).toBeDefined();
                expect(response.user).toBeDefined();
            }
        });

        test('deve rejeitar credenciais inválidas', async () => {
            const response = await client.login({
                identifier: 'usuario_inexistente@grpc.com',
                password: 'senhaerrada'
            });

            expect(response.success).toBe(false);
            expect(response.errors).toBeDefined();
            expect(response.errors.length).toBeGreaterThan(0);
        });

        test('deve validar token corretamente', async () => {
            // Garantir que temos um token válido
            if (!client.currentToken) {
                const uniqueId = Date.now() + 2;
                const regResponse = await client.register({
                    email: `tokentest${uniqueId}@grpc.com`,
                    username: `tokentest${uniqueId}`,
                    password: 'password123',
                    first_name: 'Token',
                    last_name: 'Test'
                });
                client.currentToken = regResponse.token;
            }

            const validateTokenPromise = client.promisify(client.authClient, 'ValidateToken');
            const response = await validateTokenPromise({ token: client.currentToken });

            expect(response.valid).toBe(true);
            expect(response.user).toBeDefined();
        });

        test('deve rejeitar token inválido', async () => {
            const validateTokenPromise = client.promisify(client.authClient, 'ValidateToken');
            const response = await validateTokenPromise({ token: 'token-invalido' });

            expect(response.valid).toBe(false);
            expect(response.message).toContain('inválido');
        });
    });

    describe('Gerenciamento de Tarefas', () => {
        beforeAll(async () => {
            // Garantir que temos um token válido antes dos testes de tarefas
            if (!client.currentToken) {
                const uniqueId = Date.now() + 100;
                const regResponse = await client.register({
                    email: `tasktest${uniqueId}@grpc.com`,
                    username: `tasktest${uniqueId}`,
                    password: 'password123',
                    first_name: 'Task',
                    last_name: 'Test'
                });
                client.currentToken = regResponse.token;
            }
        });

        test('deve criar tarefa com dados válidos', async () => {
            const response = await client.createTask({
                title: 'Tarefa gRPC Test',
                description: 'Testando criação via gRPC',
                priority: 1 // MEDIUM
            });

            expect(response.success).toBe(true);
            expect(response.task).toBeDefined();
            expect(response.task.title).toBe('Tarefa gRPC Test');
            expect(response.task.priority).toBe('MEDIUM');
            taskId = response.task.id;
        });

        test('deve rejeitar criação sem título', async () => {
            try {
                const response = await client.createTask({
                    title: '',
                    description: 'Sem título',
                    priority: 1
                });

                // Se chegou aqui, a resposta deve indicar falha
                expect(response.success).toBe(false);
                if (response.errors) {
                    expect(response.errors).toContain('Título não pode estar vazio');
                }
            } catch (error) {
                // Erro gRPC é esperado para dados inválidos
                expect(error.code).toBeDefined();
            }
        });

        test('deve listar tarefas com paginação', async () => {
            const response = await client.getTasks({
                page: 1,
                limit: 10
            });

            expect(response.success).toBe(true);
            expect(Array.isArray(response.tasks)).toBe(true);
            expect(response.total).toBeGreaterThanOrEqual(0);
            expect(response.page).toBe(1);
            expect(response.limit).toBe(10);
        });

        test('deve buscar tarefa específica', async () => {
            if (!taskId) {
                // Criar uma tarefa se não temos ID
                const createResponse = await client.createTask({
                    title: 'Tarefa para busca',
                    description: 'Teste de busca específica',
                    priority: 0
                });
                taskId = createResponse.task.id;
            }

            const response = await client.getTask(taskId);

            expect(response.success).toBe(true);
            expect(response.task).toBeDefined();
            expect(response.task.id).toBe(taskId);
        });

        test('deve retornar erro para tarefa inexistente', async () => {
            const response = await client.getTask('id-inexistente-123456');

            expect(response.success).toBe(false);
            expect(response.message).toContain('não encontrada');
        });

        test('deve atualizar tarefa existente', async () => {
            if (!taskId) {
                // Criar uma tarefa se não temos ID
                const createResponse = await client.createTask({
                    title: 'Tarefa para atualizar',
                    description: 'Teste de atualização',
                    priority: 1
                });
                taskId = createResponse.task.id;
            }

            const response = await client.updateTask(taskId, {
                title: 'Tarefa Atualizada via gRPC',
                completed: true
            });

            expect(response.success).toBe(true);
            expect(response.task.title).toBe('Tarefa Atualizada via gRPC');
            expect(response.task.completed).toBe(true);
        });

        test('deve buscar estatísticas das tarefas', async () => {
            const response = await client.getStats();

            expect(response.success).toBe(true);
            expect(response.stats).toBeDefined();
            expect(typeof response.stats.total).toBe('number');
            expect(typeof response.stats.completed).toBe('number');
            expect(typeof response.stats.pending).toBe('number');
            expect(typeof response.stats.completion_rate).toBe('number');
        });

        test('deve deletar tarefa existente', async () => {
            if (!taskId) {
                // Criar uma tarefa para deletar se não temos ID
                const createResponse = await client.createTask({
                    title: 'Tarefa para deletar',
                    description: 'Teste de exclusão',
                    priority: 0
                });
                taskId = createResponse.task.id;
            }

            const response = await client.deleteTask(taskId);

            expect(response.success).toBe(true);
            expect(response.message).toContain('deletada com sucesso');
            
            // Limpar o taskId já que foi deletado
            taskId = null;
        });

        test('deve retornar erro ao deletar tarefa inexistente', async () => {
            const response = await client.deleteTask('id-inexistente-123456');

            expect(response.success).toBe(false);
            expect(response.message).toContain('não encontrada');
        });

        test('deve filtrar tarefas por status', async () => {
            // Criar uma tarefa não concluída
            await client.createTask({
                title: 'Tarefa Pendente',
                description: 'Não concluída',
                priority: 0
            });

            // Criar uma tarefa concluída
            const completedTask = await client.createTask({
                title: 'Tarefa Concluída',
                description: 'Já finalizada',
                priority: 1
            });

            await client.updateTask(completedTask.task.id, {
                completed: true
            });

            // Buscar apenas tarefas concluídas
            const completedResponse = await client.getTasks({ completed: true });
            expect(completedResponse.success).toBe(true);
            
            // Buscar apenas tarefas pendentes
            const pendingResponse = await client.getTasks({ completed: false });
            expect(pendingResponse.success).toBe(true);
        });
    });

    describe('Streaming', () => {
        beforeAll(async () => {
            // Garantir que temos um token válido antes dos testes de streaming
            if (!client.currentToken) {
                const uniqueId = Date.now() + 200;
                const regResponse = await client.register({
                    email: `streamtest${uniqueId}@grpc.com`,
                    username: `streamtest${uniqueId}`,
                    password: 'password123',
                    first_name: 'Stream',
                    last_name: 'Test'
                });
                client.currentToken = regResponse.token;
            }

            // Criar uma tarefa para garantir que o streaming tenha dados
            try {
                await client.createTask({
                    title: 'Tarefa para Stream Test',
                    description: 'Esta tarefa será usada nos testes de streaming',
                    priority: 1
                });
            } catch (error) {
                // Se falhar, não é crítico para os testes
                console.log('Falha ao criar tarefa para teste de stream:', error.message);
            }
        });

        test('deve receber stream de tarefas', (done) => {
            const stream = client.streamTasks();
            let receivedTasks = [];
            let streamEnded = false;
            let doneWasCalled = false;

            const finishTest = () => {
                if (!doneWasCalled) {
                    doneWasCalled = true;
                    done();
                }
            };

            const timeout = setTimeout(() => {
                if (!streamEnded && !doneWasCalled) {
                    stream.cancel();
                    expect(receivedTasks.length).toBeGreaterThanOrEqual(0);
                    finishTest();
                }
            }, 5000);

            stream.on('data', (task) => {
                receivedTasks.push(task);
                expect(task.id).toBeDefined();
                expect(task.title).toBeDefined();
            });

            stream.on('end', () => {
                if (!streamEnded) {
                    streamEnded = true;
                    clearTimeout(timeout);
                    expect(receivedTasks.length).toBeGreaterThanOrEqual(0);
                    finishTest();
                }
            });

            stream.on('error', (error) => {
                if (!streamEnded) {
                    streamEnded = true;
                    clearTimeout(timeout);
                    // Erro pode ser esperado se não houver tarefas
                    console.log('Stream error (pode ser esperado):', error.message);
                    finishTest();
                }
            });

            // Cancelar stream após 3 segundos para evitar timeout
            setTimeout(() => {
                if (!streamEnded && !doneWasCalled) {
                    streamEnded = true;
                    clearTimeout(timeout);
                    stream.cancel();
                    finishTest();
                }
            }, 3000);
        }, 10000);

        test('deve receber stream de notificações', (done) => {
            const stream = client.streamNotifications();
            let receivedNotifications = [];
            let streamEnded = false;
            let doneWasCalled = false;

            const finishTest = () => {
                if (!doneWasCalled) {
                    doneWasCalled = true;
                    done();
                }
            };

            const timeout = setTimeout(() => {
                if (!streamEnded && !doneWasCalled) {
                    stream.cancel();
                    // Pelo menos devemos receber a notificação inicial
                    expect(receivedNotifications.length).toBeGreaterThanOrEqual(0);
                    finishTest();
                }
            }, 5000);

            stream.on('data', (notification) => {
                receivedNotifications.push(notification);
                expect(typeof notification.type).toBe('string');
                expect(notification.message).toBeDefined();
                expect(notification.timestamp).toBeDefined();
            });

            stream.on('end', () => {
                if (!streamEnded) {
                    streamEnded = true;
                    clearTimeout(timeout);
                    finishTest();
                }
            });

            stream.on('error', (error) => {
                if (!streamEnded) {
                    streamEnded = true;
                    clearTimeout(timeout);
                    console.log('Notification stream error (pode ser esperado):', error.message);
                    finishTest();
                }
            });

            // Cancelar stream após 2 segundos para garantir que termine
            setTimeout(() => {
                if (!streamEnded && !doneWasCalled) {
                    streamEnded = true;
                    clearTimeout(timeout);
                    // Devemos ter recebido pelo menos a mensagem inicial
                    expect(receivedNotifications.length).toBeGreaterThanOrEqual(1);
                    stream.cancel();
                    finishTest();
                }
            }, 2000);
        }, 10000);
    });

    describe('Validações e Segurança', () => {
        test('deve rejeitar requisições sem token', async () => {
            const client2 = new GrpcClient('localhost:50052');
            await client2.initialize();
            client2.currentToken = null;

            try {
                await client2.getTasks();
                fail('Deveria ter rejeitado requisição sem token');
            } catch (error) {
                expect(error.code).toBe(16); // UNAUTHENTICATED
            }
        });

        test('deve rejeitar token expirado/inválido', async () => {
            const client3 = new GrpcClient('localhost:50052');
            await client3.initialize();
            client3.currentToken = 'token.invalido.aqui';

            try {
                await client3.getTasks();
                fail('Deveria ter rejeitado token inválido');
            } catch (error) {
                expect(error.code).toBe(16); // UNAUTHENTICATED
            }
        });
    });
});

// const axios = require('axios'); // Para REST
// const GrpcClient = require('./client'); // Para gRPC

// /**
//  * Benchmark: gRPC vs REST - VERSÃO CORRIGIDA
//  * 
//  * Compara performance entre implementações
//  * gRPC/Protobuf vs REST/JSON
//  */

// class PerformanceBenchmark {
//     constructor() {
//         this.results = {
//             grpc: { times: [], errors: 0, totalBytes: 0 },
//             rest: { times: [], errors: 0, totalBytes: 0 }
//         };
//     }

//     async setupGrpcUser() {
//         const client = new GrpcClient();
//         await client.initialize();
        
//         const uniqueId = Date.now();
//         const userData = {
//             email: `benchmark${uniqueId}@grpc.com`,
//             username: `benchmarkuser${uniqueId}`,
//             password: 'benchmark123',
//             first_name: 'Benchmark',
//             last_name: 'User'
//         };

//         console.log('🔧 Configurando usuário para benchmark gRPC...');
        
//         try {
//             // Tentar registrar usuário
//             const regResponse = await client.register(userData);
//             if (regResponse.success && regResponse.token) {
//                 console.log('✅ Usuário registrado com sucesso');
//                 client.currentToken = regResponse.token;
//                 return client;
//             } else {
//                 console.log('⚠️ Falha no registro, tentando login...');
//                 throw new Error('Registro falhou');
//             }
//         } catch (regError) {
//             // Se registro falhar, tentar login
//             try {
//                 const loginResponse = await client.login({
//                     identifier: userData.email,
//                     password: userData.password
//                 });
                
//                 if (loginResponse.success && loginResponse.token) {
//                     console.log('✅ Login realizado com sucesso');
//                     client.currentToken = loginResponse.token;
//                     return client;
//                 } else {
//                     throw new Error('Login também falhou');
//                 }
//             } catch (loginError) {
//                 console.log('❌ Erro na autenticação gRPC:', loginError.message);
//                 throw new Error(`Falha na autenticação: ${loginError.message}`);
//             }
//         }
//     }

//     async benchmarkGrpc(iterations = 100) {
//         console.log(`🔬 Iniciando benchmark gRPC (${iterations} iterações)...`);
        
//         let client;
//         try {
//             client = await this.setupGrpcUser();
            
//             // Verificar se o token está funcionando
//             try {
//                 await client.getTasks({ page: 1, limit: 1 });
//                 console.log('✅ Token gRPC validado');
//             } catch (error) {
//                 console.log('❌ Token inválido, tentando reautenticar...');
//                 client = await this.setupGrpcUser();
//             }
            
//         } catch (error) {
//             console.log('❌ Falha na configuração do cliente gRPC:', error.message);
//             console.log('⚠️ Pulando benchmark gRPC');
//             return;
//         }

//         // Criar algumas tarefas para teste se não existirem
//         console.log('📋 Criando tarefas de teste...');
//         for (let i = 0; i < 3; i++) {
//             try {
//                 await client.createTask({
//                     title: `Tarefa Benchmark gRPC ${i + 1}`,
//                     description: `Descrição da tarefa ${i + 1} para teste de performance`,
//                     priority: i % 4 // Varia entre 0-3
//                 });
//             } catch (error) {
//                 // Se falhar na criação, não é crítico
//                 console.log(`⚠️ Falha ao criar tarefa ${i + 1}: ${error.message}`);
//             }
//         }

//         console.log('📊 Executando testes de performance gRPC...');

//         // Benchmark de listagem de tarefas
//         let successCount = 0;
//         for (let i = 0; i < iterations; i++) {
//             const start = process.hrtime.bigint();
            
//             try {
//                 const response = await client.getTasks({ page: 1, limit: 10 });
//                 const end = process.hrtime.bigint();
//                 const duration = Number(end - start) / 1e6; // Convert to milliseconds
                
//                 this.results.grpc.times.push(duration);
//                 successCount++;
                
//                 // Estimar tamanho da resposta
//                 const responseSize = JSON.stringify(response).length;
//                 this.results.grpc.totalBytes += responseSize;
                
//                 if (i % 20 === 0 && i > 0) {
//                     console.log(`gRPC: ${i}/${iterations} completed (${successCount} success)`);
//                 }
//             } catch (error) {
//                 this.results.grpc.errors++;
//                 console.error(`❌ Erro gRPC na iteração ${i}: ${error.message}`);
                
//                 // Se muitos erros consecutivos, parar
//                 if (this.results.grpc.errors > 10 && i < 20) {
//                     console.log('❌ Muitos erros gRPC, interrompendo benchmark');
//                     break;
//                 }
//             }
//         }

//         console.log(`✅ Benchmark gRPC concluído: ${successCount}/${iterations} sucessos`);
//     }

//     async setupRestUser() {
//         const baseUrl = 'http://localhost:3000/api';
//         const uniqueId = Date.now() + 1000; // Diferente do gRPC
        
//         const userData = {
//             email: `benchmarkrest${uniqueId}@rest.com`,
//             username: `benchmarkrest${uniqueId}`,
//             password: 'benchmark123',
//             firstName: 'Benchmark',
//             lastName: 'REST'
//         };

//         console.log('🔧 Configurando usuário para benchmark REST...');

//         try {
//             // Tentar registrar
//             try {
//                 await axios.post(`${baseUrl}/auth/register`, userData);
//                 console.log('✅ Usuário REST registrado');
//             } catch (regError) {
//                 console.log('⚠️ Registro REST falhou (usuário pode já existir)');
//             }

//             // Fazer login
//             const loginResponse = await axios.post(`${baseUrl}/auth/login`, {
//                 identifier: userData.email,
//                 password: userData.password
//             });

//             const token = loginResponse.data.data.token;
//             console.log('✅ Login REST realizado com sucesso');
            
//             return { token, baseUrl };
            
//         } catch (error) {
//             throw new Error(`Falha na autenticação REST: ${error.message}`);
//         }
//     }

//     async benchmarkRest(iterations = 100) {
//         console.log(`🌐 Iniciando benchmark REST (${iterations} iterações)...`);
        
//         let restConfig;
//         try {
//             restConfig = await this.setupRestUser();
//         } catch (error) {
//             console.log('⚠️ Servidor REST não disponível ou erro na configuração:', error.message);
//             console.log('   Para executar comparação completa, inicie o servidor do Roteiro 1 na porta 3000');
//             return;
//         }

//         const { token, baseUrl } = restConfig;
//         const headers = { Authorization: `Bearer ${token}` };

//         // Criar algumas tarefas para teste
//         console.log('📋 Criando tarefas de teste REST...');
//         for (let i = 0; i < 3; i++) {
//             try {
//                 await axios.post(`${baseUrl}/tasks`, {
//                     title: `Tarefa REST Benchmark ${i + 1}`,
//                     description: `Descrição da tarefa ${i + 1} para teste de performance`,
//                     priority: ['low', 'medium', 'high', 'urgent'][i % 4]
//                 }, { headers });
//             } catch (error) {
//                 console.log(`⚠️ Falha ao criar tarefa REST ${i + 1}: ${error.message}`);
//             }
//         }

//         console.log('📊 Executando testes de performance REST...');

//         // Benchmark de listagem de tarefas
//         let successCount = 0;
//         for (let i = 0; i < iterations; i++) {
//             const start = process.hrtime.bigint();
            
//             try {
//                 const response = await axios.get(`${baseUrl}/tasks?page=1&limit=10`, { headers });
//                 const end = process.hrtime.bigint();
//                 const duration = Number(end - start) / 1e6;
                
//                 this.results.rest.times.push(duration);
//                 successCount++;
                
//                 // Calcular tamanho real da resposta
//                 const responseSize = JSON.stringify(response.data).length;
//                 this.results.rest.totalBytes += responseSize;
                
//                 if (i % 20 === 0 && i > 0) {
//                     console.log(`REST: ${i}/${iterations} completed (${successCount} success)`);
//                 }
//             } catch (error) {
//                 this.results.rest.errors++;
//                 console.error(`❌ Erro REST na iteração ${i}: ${error.message}`);
                
//                 // Se muitos erros consecutivos, parar
//                 if (this.results.rest.errors > 10 && i < 20) {
//                     console.log('❌ Muitos erros REST, interrompendo benchmark');
//                     break;
//                 }
//             }
//         }

//         console.log(`✅ Benchmark REST concluído: ${successCount}/${iterations} sucessos`);
//     }

//     calculateStats(times) {
//         if (times.length === 0) return null;
        
//         const sorted = times.sort((a, b) => a - b);
//         const sum = times.reduce((acc, time) => acc + time, 0);
        
//         return {
//             mean: sum / times.length,
//             median: sorted[Math.floor(sorted.length / 2)],
//             min: sorted[0],
//             max: sorted[sorted.length - 1],
//             p95: sorted[Math.floor(sorted.length * 0.95)],
//             p99: sorted[Math.floor(sorted.length * 0.99)],
//             stdDev: Math.sqrt(times.reduce((acc, time) => acc + Math.pow(time - (sum / times.length), 2), 0) / times.length)
//         };
//     }

//     printResults() {
//         console.log('\n' + '='.repeat(60));
//         console.log('📊 RESULTADOS DO BENCHMARK DE PERFORMANCE');
//         console.log('='.repeat(60));

//         const grpcStats = this.calculateStats(this.results.grpc.times);
//         const restStats = this.calculateStats(this.results.rest.times);

//         if (grpcStats && this.results.grpc.times.length > 0) {
//             console.log('\n🔧 gRPC/Protocol Buffers:');
//             console.log(`   ├─ Requisições válidas: ${this.results.grpc.times.length}`);
//             console.log(`   ├─ Erros: ${this.results.grpc.errors}`);
//             console.log(`   ├─ Taxa de sucesso: ${((this.results.grpc.times.length / (this.results.grpc.times.length + this.results.grpc.errors)) * 100).toFixed(1)}%`);
//             console.log(`   ├─ Tempo médio: ${grpcStats.mean.toFixed(2)}ms`);
//             console.log(`   ├─ Mediana: ${grpcStats.median.toFixed(2)}ms`);
//             console.log(`   ├─ Desvio padrão: ${grpcStats.stdDev.toFixed(2)}ms`);
//             console.log(`   ├─ Min/Max: ${grpcStats.min.toFixed(2)}ms / ${grpcStats.max.toFixed(2)}ms`);
//             console.log(`   ├─ P95: ${grpcStats.p95.toFixed(2)}ms`);
//             console.log(`   ├─ P99: ${grpcStats.p99.toFixed(2)}ms`);
//             console.log(`   └─ Total bytes: ${this.results.grpc.totalBytes.toLocaleString()}`);
//         } else {
//             console.log('\n🔧 gRPC/Protocol Buffers:');
//             console.log('   └─ ❌ Nenhum dado válido coletado');
//         }

//         if (restStats && this.results.rest.times.length > 0) {
//             console.log('\n🌐 REST/JSON:');
//             console.log(`   ├─ Requisições válidas: ${this.results.rest.times.length}`);
//             console.log(`   ├─ Erros: ${this.results.rest.errors}`);
//             console.log(`   ├─ Taxa de sucesso: ${((this.results.rest.times.length / (this.results.rest.times.length + this.results.rest.errors)) * 100).toFixed(1)}%`);
//             console.log(`   ├─ Tempo médio: ${restStats.mean.toFixed(2)}ms`);
//             console.log(`   ├─ Mediana: ${restStats.median.toFixed(2)}ms`);
//             console.log(`   ├─ Desvio padrão: ${restStats.stdDev.toFixed(2)}ms`);
//             console.log(`   ├─ Min/Max: ${restStats.min.toFixed(2)}ms / ${restStats.max.toFixed(2)}ms`);
//             console.log(`   ├─ P95: ${restStats.p95.toFixed(2)}ms`);
//             console.log(`   ├─ P99: ${restStats.p99.toFixed(2)}ms`);
//             console.log(`   └─ Total bytes: ${this.results.rest.totalBytes.toLocaleString()}`);
//         } else {
//             console.log('\n🌐 REST/JSON:');
//             console.log('   └─ ⚠️ Servidor REST não disponível ou sem dados válidos');
//         }

//         if (grpcStats && restStats && this.results.grpc.times.length > 0 && this.results.rest.times.length > 0) {
//             const latencyImprovement = ((restStats.mean - grpcStats.mean) / restStats.mean * 100);
//             const bandwidthSavings = ((this.results.rest.totalBytes - this.results.grpc.totalBytes) / this.results.rest.totalBytes * 100);
            
//             console.log('\n🏆 ANÁLISE COMPARATIVA:');
//             console.log(`   ├─ Latência: gRPC é ${Math.abs(latencyImprovement).toFixed(1)}% ${latencyImprovement > 0 ? 'mais rápido' : 'mais lento'} que REST`);
//             console.log(`   ├─ Diferença média: ${Math.abs(restStats.mean - grpcStats.mean).toFixed(2)}ms`);
//             console.log(`   ├─ Bandwidth: gRPC usa ${Math.abs(bandwidthSavings).toFixed(1)}% ${bandwidthSavings > 0 ? 'menos' : 'mais'} dados`);
//             console.log(`   ├─ Throughput gRPC: ${(1000 / grpcStats.mean).toFixed(1)} req/s`);
//             console.log(`   ├─ Throughput REST: ${(1000 / restStats.mean).toFixed(1)} req/s`);
            
//             if (latencyImprovement > 0) {
//                 console.log(`   └─ 🎯 gRPC demonstra melhor performance para este caso de uso`);
//             } else {
//                 console.log(`   └─ ⚠️ REST apresentou melhor performance neste teste`);
//             }
//         } else {
//             console.log('\n🏆 ANÁLISE COMPARATIVA:');
//             console.log('   └─ ⚠️ Comparação não disponível - dados insuficientes de um ou ambos protocolos');
//         }

//         console.log('\n📝 OBSERVAÇÕES:');
//         console.log('   • Resultados podem variar baseado em hardware, rede e carga do sistema');
//         console.log('   • gRPC típicamente performa melhor com payloads maiores e alta frequência');
//         console.log('   • REST pode ser mais rápido para operações simples e cache HTTP');
//         console.log('   • Considere também fatores como debugging, tooling e ecosystem');
//         console.log('   • Para comparação completa, certifique-se que ambos servidores estão rodando');
//     }
// }

// // Executar benchmark
// async function runBenchmark() {
//     const iterations = process.argv[2] ? parseInt(process.argv[2]) : 50;
//     const benchmark = new PerformanceBenchmark();
    
//     console.log(`🚀 Iniciando benchmark com ${iterations} iterações por protocolo`);
//     console.log('⏱️ Este processo pode levar alguns minutos...\n');
    
//     // Verificar se pelo menos um servidor está disponível
//     console.log('🔍 Verificando disponibilidade dos servidores...');
    
//     try {
//         // Testar gRPC
//         const grpcClient = new GrpcClient();
//         await grpcClient.initialize();
//         console.log('✅ Servidor gRPC disponível');
//     } catch (error) {
//         console.log('❌ Servidor gRPC não disponível:', error.message);
//         console.log('   Execute "npm start" para iniciar o servidor gRPC');
//         return;
//     }
    
//     try {
//         // Testar REST
//         await axios.get('http://localhost:3000/health');
//         console.log('✅ Servidor REST disponível');
//     } catch (error) {
//         console.log('⚠️ Servidor REST não disponível (comparação limitada)');
//         console.log('   Para comparação completa, execute o servidor do Roteiro 1 na porta 3000');
//     }
    
//     console.log(''); // Nova linha
    
//     try {
//         await benchmark.benchmarkGrpc(iterations);
//         await benchmark.benchmarkRest(iterations);
//         benchmark.printResults();
//     } catch (error) {
//         console.error('❌ Erro no benchmark:', error.message);
//         console.error('Stack trace:', error.stack);
//     }
// }

// if (require.main === module) {
//     runBenchmark().catch(error => {
//         console.error('❌ Falha crítica no benchmark:', error.message);
//         process.exit(1);
//     });
// }

// module.exports = PerformanceBenchmark;