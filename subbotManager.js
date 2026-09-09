const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const CONFIG_FILE = path.join(__dirname, 'subbots-config.json');
const SESSIONS_BASE_DIR = path.join(__dirname, 'sessions');

class SubbotManager {
  constructor() {
    this.config = {
      limiteMaximo: 2,
      subbots: {} // { [id]: { id, ownerJid, phone, status, createdAt, connectedAt } }
    };
    this.activeSockets = new Map(); // id -> sock
    this.connectingStates = new Map(); // userJid -> { step, method, phone, id, timeoutHandle }
    this.carregarConfig();
    this.garantirDiretorios();
  }

  garantirDiretorios() {
    if (!fs.existsSync(SESSIONS_BASE_DIR)) {
      fs.mkdirSync(SESSIONS_BASE_DIR, { recursive: true });
    }
  }

  carregarConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        this.config = {
          prefixo: data.prefixo ?? '!',
          limiteMaximo: data.limiteMaximo ?? 2,
          subbots: data.subbots ?? {}
        };
      } else {
        this.salvarConfig();
      }
    } catch (e) {
      console.error('❌ Erro ao carregar subbots-config.json:', e.message);
      this.config = { prefixo: '!', limiteMaximo: 2, subbots: {} };
    }
  }

  salvarConfig() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error('❌ Erro ao salvar subbots-config.json:', e.message);
    }
  }

  getPrefixo() {
    return this.config.prefixo || '!';
  }

  setPrefixo(novoPrefixo) {
    this.config.prefixo = novoPrefixo;
    this.salvarConfig();
  }

  getLimiteMaximo() {
    return this.config.limiteMaximo;
  }

  setLimiteMaximo(novoLimite) {
    this.config.limiteMaximo = novoLimite;
    this.salvarConfig();
  }

  getAtivosCount() {
    return Object.values(this.config.subbots).filter(s => s.status === 'conectado').length;
  }

  getTotalRegistrados() {
    return Object.keys(this.config.subbots).length;
  }

  temVaga() {
    return this.getAtivosCount() < this.config.limiteMaximo;
  }

  getSubbotPorUsuario(userJid) {
    const cleanJid = userJid.split('@')[0];
    return Object.values(this.config.subbots).find(
      s => s.ownerJid.includes(cleanJid) && s.status === 'conectado'
    );
  }

  listarSubbots() {
    const lista = Object.values(this.config.subbots);
    if (lista.length === 0) {
      return `📋 *Nenhum sub-bot registrado no momento.*\n\n• Limite atual: ${this.config.limiteMaximo} conexões`;
    }

    let msg = `🤖 *LISTA DE SUB-BOTS*\n`;
    msg += `📊 *Vagas:* ${this.getAtivosCount()}/${this.config.limiteMaximo} ativas\n`;
    msg += `─────────────────────────\n`;

    lista.forEach((sub, index) => {
      const statusIcon = sub.status === 'conectado' ? '🟢 Conectado' : '🔴 Desconectado';
      msg += `*${index + 1}.* ID: \`${sub.id}\`\n`;
      msg += `   📱 Número: ${sub.phone || 'N/D'}\n`;
      msg += `   👤 Solicitado por: @${sub.ownerJid.split('@')[0]}\n`;
      msg += `   📡 Status: ${statusIcon}\n`;
      if (sub.connectedAt) {
        msg += `   ⏱️ Ativo desde: ${new Date(sub.connectedAt).toLocaleString('pt-BR')}\n`;
      }
      msg += `─────────────────────────\n`;
    });

    return msg;
  }

  gerarProximoId() {
    let id = 1;
    while (this.config.subbots[String(id)]) {
      id++;
    }
    return String(id);
  }

  limparEstado(userJid) {
    const estado = this.connectingStates.get(userJid);
    if (estado && estado.timeoutHandle) {
      clearTimeout(estado.timeoutHandle);
    }
    this.connectingStates.delete(userJid);
  }

  async deletarSubbot(id) {
    const sub = this.config.subbots[String(id)];
    if (!sub) return false;

    const sock = this.activeSockets.get(String(id));
    if (sock) {
      try { sock.ws.close(); } catch (_) {}
      try { sock.ev.removeAllListeners(); } catch (_) {}
      this.activeSockets.delete(String(id));
    }

    const sessionPath = path.join(SESSIONS_BASE_DIR, `subbot_${id}`);
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Erro ao apagar pasta de sessão subbot_${id}:`, e.message);
    }

    delete this.config.subbots[String(id)];
    this.salvarConfig();
    return true;
  }

  async iniciarConexao({ id, userJid, method, phone, onQRCode, onPairingCode, onConnected, onError }) {
    const sessionDir = path.join(SESSIONS_BASE_DIR, `subbot_${id}`);
    let resolvido = false;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      const subSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        emitOwnEvents: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        getMessage: async () => undefined,
      });

      this.activeSockets.set(String(id), subSock);
      subSock.ev.on('creds.update', saveCreds);

      // Se for pairing code
      if (method === '2' && !state.creds.registered && phone) {
        setTimeout(async () => {
          try {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const code = await subSock.requestPairingCode(cleanPhone);
            if (onPairingCode) onPairingCode(code);
          } catch (err) {
            console.error(`[SubBot ${id}] Erro ao gerar pairing code:`, err.message);
            if (onError) onError(`Não foi possível gerar o código: ${err.message}`);
          }
        }, 3000);
      }

      // Eventos de conexão
      subSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && method === '1' && !resolvido) {
          try {
            const qrBuffer = await QRCode.toBuffer(qr, { scale: 8 });
            if (onQRCode) onQRCode(qrBuffer);
          } catch (err) {
            console.error(`[SubBot ${id}] Erro ao gerar buffer QR:`, err.message);
            if (onError) onError('Falha ao renderizar a imagem do QR Code.');
          }
        }

        if (connection === 'open') {
          resolvido = true;
          const phoneConectado = subSock.user?.id?.split(':')[0] || phone || 'Desconhecido';
          
          this.config.subbots[String(id)] = {
            id: String(id),
            ownerJid: userJid,
            phone: phoneConectado,
            status: 'conectado',
            connectedAt: Date.now()
          };
          this.salvarConfig();

          console.log(`✅ [SubBot ${id}] Conectado com sucesso para ${userJid}!`);
          if (onConnected) onConnected(phoneConectado);

          // Manter presença online básica
          subSock.sendPresenceUpdate('available').catch(() => {});
          setInterval(() => {
            if (this.activeSockets.has(String(id))) {
              subSock.sendPresenceUpdate('available').catch(() => {});
            }
          }, 30000);
        }

        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          console.log(`⚠️ [SubBot ${id}] Conexão fechada. Razão: ${reason}`);

          if (reason === DisconnectReason.loggedOut || reason === 401) {
            console.log(`❌ [SubBot ${id}] Desconectado pelo usuário/sessão inválida.`);
            this.deletarSubbot(id);
          } else if (reason === 515 || reason === DisconnectReason.restartRequired) {
            // 515 = Pareamento bem-sucedido! O Baileys reinicia o socket para abrir a sessão
            console.log(`🔄 [SubBot ${id}] Pareamento aceito! Reiniciando socket para abrir sessão (515 restartRequired)...`);
            setTimeout(() => {
              this.iniciarConexao({ id, userJid, method, phone, onQRCode, onPairingCode, onConnected, onError });
            }, 2000);
          } else if (!resolvido) {
            if (onError) onError(`Conexão não estabelecida (código: ${reason || 'desconhecido'}).`);
          } else {
            // Reconexão de rotina para subbot já conectado
            console.log(`🔄 [SubBot ${id}] Reconectando em 5s...`);
            setTimeout(() => {
              this.iniciarConexao({ id, userJid, method, phone, onQRCode, onPairingCode, onConnected, onError });
            }, 5000);
          }
        }
      });

    } catch (err) {
      console.error(`❌ [SubBot ${id}] Erro geral na inicialização:`, err.message);
      if (onError) onError(err.message);
    }
  }

  async reconectarSubbotsSalvos() {
    const ids = Object.keys(this.config.subbots);
    if (ids.length === 0) return;

    console.log(`🔄 Reconectando ${ids.length} sub-bot(s) salvos...`);

    for (const id of ids) {
      const sub = this.config.subbots[id];
      const sessionDir = path.join(SESSIONS_BASE_DIR, `subbot_${id}`);

      if (!fs.existsSync(sessionDir)) {
        delete this.config.subbots[id];
        continue;
      }

      try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const subSock = makeWASocket({
          version,
          logger: pino({ level: 'silent' }),
          browser: Browsers.ubuntu('Chrome'),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
          },
          emitOwnEvents: false,
          markOnlineOnConnect: true,
          connectTimeoutMs: 60000,
          getMessage: async () => undefined,
        });

        this.activeSockets.set(String(id), subSock);
        subSock.ev.on('creds.update', saveCreds);

        subSock.ev.on('connection.update', (update) => {
          const { connection, lastDisconnect } = update;
          if (connection === 'open') {
            console.log(`✅ [SubBot ${id}] Reconectado automaticamente!`);
            this.config.subbots[id].status = 'conectado';
            this.salvarConfig();
          }
          if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut || reason === 401) {
              this.deletarSubbot(id);
            } else {
              console.log(`🔄 [SubBot ${id}] Reconectando em 5s...`);
              setTimeout(() => this.reconectarSubbotIndividual(id), 5000);
            }
          }
        });
      } catch (err) {
        console.error(`Erro ao reconectar SubBot ${id}:`, err.message);
      }
    }
    this.salvarConfig();
  }

  async reconectarSubbotIndividual(id) {
    const sub = this.config.subbots[id];
    const sessionDir = path.join(SESSIONS_BASE_DIR, `subbot_${id}`);
    if (!sub || !fs.existsSync(sessionDir)) return;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      const subSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        emitOwnEvents: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        getMessage: async () => undefined,
      });

      this.activeSockets.set(String(id), subSock);
      subSock.ev.on('creds.update', saveCreds);

      subSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          console.log(`✅ [SubBot ${id}] Reconectado automaticamente!`);
          this.config.subbots[id].status = 'conectado';
          this.salvarConfig();
        }
        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut || reason === 401) {
            this.deletarSubbot(id);
          } else {
            console.log(`🔄 [SubBot ${id}] Reconectando em 5s...`);
            setTimeout(() => this.reconectarSubbotIndividual(id), 5000);
          }
        }
      });
    } catch (err) {
      console.error(`Erro ao reconectar SubBot individual ${id}:`, err.message);
    }
  }
}

module.exports = new SubbotManager();
