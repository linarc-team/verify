const API_URL = globalThis.location.origin;
console.log('API URL:', API_URL);

let currentUserId = null;
let timerInterval = null;
let timeLeft = 180; // 3 minutos em segundos
let captchaToken = null;
let botCheckToken = null;
let browserFingerprint = null;

// Gerar fingerprint do navegador (verificação anti-bot)
function generateFingerprint() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('Browser fingerprint', 2, 2);
    
    const fingerprint = [
        navigator.userAgent,
        navigator.language,
        screen.width + 'x' + screen.height,
        new Date().getTimezoneOffset(),
        canvas.toDataURL().substring(0, 50)
    ].join('|');
    
    // Hash simples (não criptográfico, apenas para verificação)
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
        const char = fingerprint.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
}

// Inicializar verificação de bot ao carregar a página
async function initializeBotCheck() {
    try {
        browserFingerprint = generateFingerprint();
        const response = await fetch(`${API_URL}/api/bot-check`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ fingerprint: browserFingerprint })
        });
        
        if (response.ok) {
            const data = await response.json();
            botCheckToken = data.token;
        }
    } catch (error) {
        console.error('Erro ao inicializar verificação de bot:', error);
    }
}

// Carregar captcha
async function loadCaptcha() {
    try {
        const response = await fetch(`${API_URL}/api/captcha`);
        if (response.ok) {
            const data = await response.json();
            captchaToken = data.token;
            document.getElementById('captchaQuestion').textContent = data.question + ' = ?';
            document.getElementById('captchaAnswer').value = '';
        }
    } catch (error) {
        console.error('Erro ao carregar captcha:', error);
        showError(error1, 'Erro ao carregar verificação. Recarregue a página.');
    }
}

// Inicializar ao carregar
document.addEventListener('DOMContentLoaded', () => {
    initializeBotCheck();
    loadCaptcha();
    
    // Botão de atualizar captcha
    document.getElementById('refreshCaptcha').addEventListener('click', (e) => {
        e.preventDefault();
        loadCaptcha();
    });
});

// Elementos do DOM
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const userIdForm = document.getElementById('userIdForm');
const codeForm = document.getElementById('codeForm');
const userIdInput = document.getElementById('userId');
const codeInput = document.getElementById('verificationCode');
const timerElement = document.getElementById('timer');
const error1 = document.getElementById('error1');
const error2 = document.getElementById('error2');

// Formatação automática do código (maiúsculas)
codeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});

// Formulário de ID do Discord
userIdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(error1);
    
    const userId = userIdInput.value.trim();
    
    if (!userId || !/^\d+$/.test(userId)) {
        showError(error1, 'Por favor, insira um ID válido do Discord');
        return;
    }

    const submitBtn = userIdForm.querySelector('button');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Enviando...</span>';

    // Validar captcha
    const captchaAnswer = document.getElementById('captchaAnswer').value.trim();
    if (!captchaAnswer || !captchaToken) {
        showError(error1, 'Complete a verificação antes de continuar');
        return;
    }

    if (!botCheckToken || !browserFingerprint) {
        showError(error1, 'Verificação de navegador necessária. Recarregue a página.');
        await initializeBotCheck();
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/request-verification`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                userId,
                captchaToken,
                captchaAnswer: Number.parseInt(captchaAnswer, 10),
                botCheckToken,
                fingerprint: browserFingerprint
            })
        });

        let data;
        try {
            data = await response.json();
        } catch (jsonError) {
            console.error('Erro ao parsear JSON:', jsonError);
            showError(error1, 'Erro na resposta do servidor');
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Enviar</span>';
            return;
        }

        if (!response.ok) {
            let errorMsg = data.error || 'Erro ao enviar código';
            if (response.status === 503) {
                errorMsg = 'Bot ainda não está pronto. Aguarde alguns segundos e tente novamente.';
            }
            showError(error1, errorMsg);
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Enviar</span>';
            return;
        }

        // Sucesso - ir para próxima etapa
        currentUserId = userId;
        step1.classList.remove('active');
        step2.classList.add('active');
        codeInput.focus();
        startTimer();
        
        // Limpar captcha
        captchaToken = null;
        loadCaptcha();
        
    } catch (error) {
        console.error('Erro de conexão:', error);
        let errorMsg = 'Erro de conexão. ';
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            errorMsg += 'Verifique se o servidor está rodando.';
        } else {
            errorMsg += error.message || 'Tente novamente.';
        }
        showError(error1, errorMsg);
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Enviar</span>';
    }
});

// Formulário de código de verificação
codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(error2);
    
    const code = codeInput.value.trim().toUpperCase();
    
    if (code.length !== 5) {
        showError(error2, 'O código deve ter 5 caracteres');
        return;
    }

    const submitBtn = codeForm.querySelector('button');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Verificando...</span>';

    try {
        const response = await fetch(`${API_URL}/api/verify-code`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                userId: currentUserId,
                code: code
            })
        });

        let data;
        try {
            data = await response.json();
        } catch (jsonError) {
            console.error('Erro ao parsear JSON:', jsonError);
            showError(error2, 'Erro na resposta do servidor');
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Verificar</span>';
            return;
        }

        if (!response.ok) {
            let errorMsg = data.error || 'Código inválido';
            if (response.status === 503) {
                errorMsg = 'Bot ainda não está pronto. Aguarde alguns segundos e tente novamente.';
            }
            showError(error2, errorMsg);
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Verificar</span>';
            return;
        }

        // Sucesso - parar timer e mostrar tela de conclusão
        stopTimer();
        step2.classList.remove('active');
        step3.classList.add('active');
        
    } catch (error) {
        console.error('Erro de conexão:', error);
        let errorMsg = 'Erro de conexão. ';
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            errorMsg += 'Verifique se o servidor está rodando.';
        } else {
            errorMsg += error.message || 'Tente novamente.';
        }
        showError(error2, errorMsg);
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Verificar</span>';
    }
});

// Função para iniciar timer
function startTimer() {
    timeLeft = 180;
    updateTimer();
    
    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimer();
        
        if (timeLeft <= 0) {
            stopTimer();
            showError(error2, 'Tempo esgotado! Solicite um novo código.');
            codeInput.disabled = true;
            codeForm.querySelector('button').disabled = true;
        }
    }, 1000);
}

// Função para atualizar display do timer
function updateTimer() {
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    timerElement.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    // Mudar cor conforme o tempo
    timerElement.parentElement.classList.remove('warning', 'danger');
    if (timeLeft <= 30) {
        timerElement.parentElement.classList.add('danger');
    } else if (timeLeft <= 60) {
        timerElement.parentElement.classList.add('warning');
    }
}

// Função para parar timer
function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

// Funções auxiliares para erros
function showError(element, message) {
    element.textContent = message;
    element.classList.add('show');
}

function hideError(element) {
    element.classList.remove('show');
    element.textContent = '';
}

