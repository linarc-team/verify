const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações do Discord - usando variáveis de ambiente
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_ID = process.env.ROLE_ID;

// Validar variáveis de ambiente obrigatórias
if (!BOT_TOKEN || !GUILD_ID || !ROLE_ID) {
    console.error('ERRO: Variáveis de ambiente obrigatórias não configuradas!');
    console.error('Configure: BOT_TOKEN, GUILD_ID, ROLE_ID');
    process.exit(1);
}

// Inicializar cliente Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Armazenar códigos de verificação (em produção, use Redis ou banco de dados)
const verificationCodes = new Map(); // userId -> { code, expiresAt }

// Rate limiting simples (em produção, use redis-rate-limiter ou similar)
const rateLimit = new Map(); // userId -> { count, resetAt }
const MAX_REQUESTS_PER_MINUTE = 3;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto

// Armazenar tokens de captcha e verificação de bot
const captchaTokens = new Map(); // token -> { answer, expiresAt }
const botCheckTokens = new Map(); // token -> { fingerprint, expiresAt }

// Flag para verificar se o bot está pronto
let botReady = false;

// Middleware - CORS mais seguro
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];
app.use(cors({
    origin: (origin, callback) => {
        if (allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Não permitido por CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Log de requisições
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Endpoint de teste (não precisa do bot estar pronto)
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        botReady: botReady,
        timestamp: new Date().toISOString()
    });
});

// Middleware de rate limiting
function checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = rateLimit.get(userId);
    
    if (!userLimit || now > userLimit.resetAt) {
        rateLimit.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return true;
    }
    
    if (userLimit.count >= MAX_REQUESTS_PER_MINUTE) {
        return false;
    }
    
    userLimit.count++;
    return true;
}

// Middleware para verificar se o bot está pronto (exceto health e captcha)
app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/captcha' || req.path === '/bot-check') {
        return next();
    }
    if (!botReady) {
        return res.status(503).json({ error: 'Bot ainda não está pronto. Aguarde alguns segundos e recarregue a página.' });
    }
    next();
});

// Gerar código alfanumérico de 5 dígitos
function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Gerar token único
function generateToken() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Gerar captcha simples (números)
function generateCaptcha() {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    const answer = num1 + num2;
    return { question: `${num1} + ${num2}`, answer };
}

// Verificação básica de bot (fingerprint do navegador)
function generateBotCheck() {
    const token = generateToken();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos
    botCheckTokens.set(token, { expiresAt });
    return token;
}

// Validar token de bot check
function validateBotCheck(token, fingerprint) {
    const check = botCheckTokens.get(token);
    if (!check || Date.now() > check.expiresAt) {
        botCheckTokens.delete(token);
        return false;
    }
    botCheckTokens.delete(token);
    return true;
}

// Endpoint para gerar captcha
app.get('/api/captcha', (req, res) => {
    try {
        const captcha = generateCaptcha();
        const token = generateToken();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos
        
        captchaTokens.set(token, { answer: captcha.answer, expiresAt });
        
        res.json({ 
            token, 
            question: captcha.question 
        });
    } catch (error) {
        console.error('Erro ao gerar captcha:', error);
        res.status(500).json({ error: 'Erro ao gerar captcha' });
    }
});

// Endpoint para verificação de bot
app.post('/api/bot-check', (req, res) => {
    try {
        const { fingerprint } = req.body;
        
        if (!fingerprint || typeof fingerprint !== 'string') {
            return res.status(400).json({ error: 'Fingerprint inválido' });
        }
        
        const token = generateBotCheck();
        res.json({ token });
    } catch (error) {
        console.error('Erro ao gerar bot check:', error);
        res.status(500).json({ error: 'Erro ao gerar verificação' });
    }
});

// Endpoint para solicitar verificação
app.post('/api/request-verification', async (req, res) => {
    try {
        const { userId, captchaToken, captchaAnswer, botCheckToken, fingerprint } = req.body;

        // Validações de segurança
        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'ID do Discord inválido' });
        }

        // Rate limiting
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
        }

        // Validar captcha
        if (!captchaToken || !captchaAnswer) {
            return res.status(400).json({ error: 'Captcha é obrigatório' });
        }

        const captcha = captchaTokens.get(captchaToken);
        if (!captcha || Date.now() > captcha.expiresAt) {
            captchaTokens.delete(captchaToken);
            return res.status(400).json({ error: 'Captcha expirado ou inválido' });
        }

        if (Number.parseInt(captchaAnswer, 10) !== captcha.answer) {
            captchaTokens.delete(captchaToken);
            return res.status(400).json({ error: 'Resposta do captcha incorreta' });
        }

        captchaTokens.delete(captchaToken);

        // Validar bot check
        if (!botCheckToken || !fingerprint) {
            return res.status(400).json({ error: 'Verificação de navegador necessária' });
        }

        if (!validateBotCheck(botCheckToken, fingerprint)) {
            return res.status(400).json({ error: 'Verificação de navegador inválida' });
        }

        // Gerar código
        const code = generateCode();
        const expiresAt = Date.now() + 3 * 60 * 1000; // 3 minutos

        // Armazenar código
        verificationCodes.set(userId, { code, expiresAt });

        // Buscar usuário no servidor
        const guild = await client.guilds.fetch(GUILD_ID);
        let member;
        try {
            member = await guild.members.fetch(userId);
        } catch (error) {
            return res.status(404).json({ error: 'Usuário não encontrado no servidor' });
        }

        // Enviar DM com o código
        try {
            const dmChannel = await member.createDM();
            await dmChannel.send(`🔐 **Código de Verificação**\n\nSeu código de verificação é: **${code}**\n\nEste código expira em 3 minutos.\n\nDigite este código no site para completar a verificação.`);
        } catch (error) {
            return res.status(500).json({ error: 'Não foi possível enviar mensagem. Verifique se as DMs estão habilitadas.' });
        }

        res.json({ success: true, message: 'Código enviado com sucesso!' });
    } catch (error) {
        console.error('Erro ao solicitar verificação:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Endpoint para verificar código
app.post('/api/verify-code', async (req, res) => {
    try {
        const { userId, code } = req.body;

        if (!userId || !code) {
            return res.status(400).json({ error: 'ID e código são obrigatórios' });
        }

        // Validações
        if (!/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'ID do Discord inválido' });
        }

        if (!/^[A-Z0-9]{5}$/.test(code.toUpperCase())) {
            return res.status(400).json({ error: 'Código inválido' });
        }

        // Rate limiting
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
        }

        // Verificar se existe código para este usuário
        const verification = verificationCodes.get(userId);
        if (!verification) {
            return res.status(400).json({ error: 'Código não encontrado. Solicite um novo código.' });
        }

        // Verificar expiração
        if (Date.now() > verification.expiresAt) {
            verificationCodes.delete(userId);
            return res.status(400).json({ error: 'Código expirado. Solicite um novo código.' });
        }

        // Verificar código
        if (verification.code.toUpperCase() !== code.toUpperCase()) {
            return res.status(400).json({ error: 'Código incorreto' });
        }

        // Código correto - adicionar cargo
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(userId);
            const role = await guild.roles.fetch(ROLE_ID);

            if (!member.roles.cache.has(ROLE_ID)) {
                await member.roles.add(role);
            }

            // Remover código usado
            verificationCodes.delete(userId);

            res.json({ success: true, message: 'Verificação concluída com sucesso!' });
        } catch (error) {
            console.error('Erro ao adicionar cargo:', error);
            res.status(500).json({ error: 'Erro ao adicionar cargo. Tente novamente.' });
        }
    } catch (error) {
        console.error('Erro ao verificar código:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Conectar bot ao Discord
client.once('ready', () => {
    botReady = true;
    console.log(`Bot conectado como ${client.user.tag}`);
    console.log(`Servidor rodando na porta ${PORT}`);
});

// Iniciar servidor HTTP primeiro
app.listen(PORT, () => {
    console.log(`Servidor HTTP iniciado na porta ${PORT}`);
    console.log(`Aguardando conexão do bot Discord...`);
});

// Conectar bot ao Discord
client.login(BOT_TOKEN).catch(error => {
    console.error('Erro ao conectar bot:', error);
    console.error('Detalhes:', error.message);
    console.log('Servidor HTTP continuará rodando, mas verificações não funcionarão até o bot conectar.');
});

