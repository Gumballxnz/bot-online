const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

// ─── SUPRIMIR LOGS SENSÍVEIS DO LIBSIGNAL ───────────────
const _origLog = console.log;
const _origDir = console.dir;
const _origInfo = console.info;
const _origError = console.error;
function shouldSuppress(args) {
  const str = args.map(a => typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return str.includes('Closing session') || str.includes('SessionEntry') || str.includes('privKey') ||
    str.includes('registrationId:') || str.includes('rootKey') || str.includes('baseKey') ||
    str.includes('remoteIdentityKey') || str.includes('pendingPreKey') || str.includes('signedKeyId') ||
    str.includes('Bad MAC') || str.includes('Failed to decrypt') || str.includes('session_cipher') ||
    str.includes('Closing open session');
}
console.log = function(...args) { if (shouldSuppress(args)) return; _origLog.apply(console, args); };
console.dir = function(...args) { if (shouldSuppress(args)) return; _origDir.apply(console, args); };
console.info = function(...args) { if (shouldSuppress(args)) return; _origInfo.apply(console, args); };
console.error = function(...args) { if (shouldSuppress(args)) return; _origError.apply(console, args); };

const subbotManager = require('./subbotManager');

// ─── CONFIG ──────────────────────────────────────────────
const phoneArg = process.argv.find(a => a.startsWith('--phone='))?.split('=')[1] ||
                 (process.argv[process.argv.indexOf('--pair') + 1] && !process.argv[process.argv.indexOf('--pair') + 1].startsWith('--') ? process.argv[process.argv.indexOf('--pair') + 1] : null);

let MEU_NUMERO = phoneArg ? phoneArg.replace(/[^0-9]/g, '') : '258878760967';
const DONOS = [MEU_NUMERO, `${MEU_NUMERO}@s.whatsapp.net`, '258878760967', '258879116693'];
const SESSION_DIR = path.join(__dirname, 'session-presenca');
const ESTADO_FILE = path.join(__dirname, '.bot-estado.json');
const AUDIO_DB_FILE = path.join(__dirname, '.bot-audio-db.json');
const AUDIO_FILE_OPUS = path.join(__dirname, 'AUD-20260722-WA0210.opus');
const AUDIO_FILE_MP3 = path.join(__dirname, 'AUD-20260722-WA0210.mp3');

// ─── ESTADO ──────────────────────────────────────────────
let modoAtivo = true;
let startTime = Date.now();
let sock = null;
let presenceInterval = null;
let pairingTimeoutHandle = null;
let audioDb = {};

// Anti-duplicação: guarda IDs das mensagens já processadas
const processedMsgs = new Set();
const MAX_CACHE = 200;

function salvarEstado() {
  try { fs.writeFileSync(ESTADO_FILE, JSON.stringify({ modoAtivo })); } catch (_) {}
}
function carregarEstado() {
  try {
    if (fs.existsSync(ESTADO_FILE)) {
      const data = JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf-8'));
      modoAtivo = data.modoAtivo ?? true;
    }
  } catch (_) { modoAtivo = true; }
}

function salvarAudioDb() {
  try { fs.writeFileSync(AUDIO_DB_FILE, JSON.stringify(audioDb, null, 2)); } catch (_) {}
}
function carregarAudioDb() {
  try {
    if (fs.existsSync(AUDIO_DB_FILE)) {
      audioDb = JSON.parse(fs.readFileSync(AUDIO_DB_FILE, 'utf-8'));
    }
  } catch (_) { audioDb = {}; }
}
function getHojeDataStr() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Cache do buffer/duração do áudio para não reler do disco a cada envio
let audioBufferCache = null;
let audioSecondsCache = 6;

// Garante um OGG/Opus válido. WhatsApp PTT (nota de voz) SÓ aceita opus.
// Retorna true se o .opus existe (ou foi gerado com sucesso).
function garantirOpus() {
  if (fs.existsSync(AUDIO_FILE_OPUS)) return true;
  if (!fs.existsSync(AUDIO_FILE_MP3)) return false;

  // Tenta converter do MP3 com as flags corretas p/ WhatsApp: mono, 48kHz, opus.
  try {
    const { execSync } = require('child_process');
    execSync(
      `ffmpeg -y -i "${AUDIO_FILE_MP3}" -ac 1 -ar 48000 -c:a libopus -b:a 32k -application voip "${AUDIO_FILE_OPUS}"`,
      { stdio: 'ignore' }
    );
    return fs.existsSync(AUDIO_FILE_OPUS);
  } catch (e) {
    console.error('⚠️ ffmpeg indisponível/falhou ao gerar .opus:', e.message);
    return false;
  }
}

// Calcula a duração (em segundos) de um Ogg/Opus lendo o granule position.
function calcularDuracaoOpus(buffer) {
  try {
    let offset = 0, lastGranule = 0n, preSkip = 0;
    while (offset + 27 <= buffer.length) {
      if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') break;
      const granule = buffer.readBigUInt64LE(offset + 6);
      if (granule !== 0xffffffffffffffffn && granule > lastGranule) lastGranule = granule;
      const segCount = buffer.readUInt8(offset + 26);
      let bodyLen = 0;
      for (let i = 0; i < segCount; i++) bodyLen += buffer.readUInt8(offset + 27 + i);
      const bodyStart = offset + 27 + segCount;
      if (buffer.toString('ascii', bodyStart, bodyStart + 8) === 'OpusHead') {
        preSkip = buffer.readUInt16LE(bodyStart + 10);
      }
      offset = bodyStart + bodyLen;
    }
    const secs = Math.round(Number(lastGranule - BigInt(preSkip)) / 48000); // opus = 48kHz
    return secs > 0 ? secs : 6;
  } catch (_) {
    return 6;
  }
}

async function processarEnvioAudio(remetente) {
  try {
    // WhatsApp PTT só aceita OGG/Opus. Nunca enviar MP3 como nota de voz
    // (isso gera o erro "há algo errado com o arquivo de áudio").
    if (!garantirOpus()) {
      console.error(
        '❌ Nenhum .opus válido disponível e o ffmpeg não pôde gerar um.\n' +
        '   → Copie o AUD-20260722-WA0210.opus para a VPS OU instale o ffmpeg.\n' +
        '   NÃO vou enviar o MP3 como nota de voz para evitar áudio corrompido.'
      );
      return;
    }

    // Carrega e cacheia o buffer + duração (uma vez só)
    if (!audioBufferCache) {
      audioBufferCache = fs.readFileSync(AUDIO_FILE_OPUS);
      audioSecondsCache = calcularDuracaoOpus(audioBufferCache);
    }

    if (sock && modoAtivo) {
      await sock.sendPresenceUpdate('recording', remetente).catch(() => {});
    }

    // Aguarda exatamente 6 segundos gravando
    await new Promise(resolve => setTimeout(resolve, 6000));

    if (sock) {
      await sock.sendPresenceUpdate('paused', remetente).catch(() => {});
    }

    if (sock && modoAtivo) {
      await sock.sendMessage(remetente, {
        audio: audioBufferCache,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: audioSecondsCache,
      });
      console.log(`🎙️ Áudio diário (opus, ${audioSecondsCache}s) enviado com sucesso para: ${remetente}`);
    }
  } catch (err) {
    console.error(`❌ Erro ao enviar áudio diário para ${remetente}:`, err.message);
  }
}

// ─── PRESENÇA ONLINE ─────────────────────────────────────
function iniciarPresenca() {
  pararPresenca();
  if (!modoAtivo || !sock) return;
  sock.sendPresenceUpdate('available').catch(() => {});
  presenceInterval = setInterval(() => {
    if (sock && modoAtivo) {
      sock.sendPresenceUpdate('available').catch(() => {});
    }
  }, 25_000);
}

function pararPresenca() {
  if (presenceInterval) {
    clearInterval(presenceInterval);
    presenceInterval = null;
  }
  if (sock) sock.sendPresenceUpdate('unavailable').catch(() => {});
}

// ─── CONEXÃO ─────────────────────────────────────────────
async function conectar() {
  carregarEstado();
  carregarAudioDb();

  // Limpa timeout de pairing anterior
  if (pairingTimeoutHandle) {
    clearTimeout(pairingTimeoutHandle);
    pairingTimeoutHandle = null;
  }

  // Fecha socket anterior se existir
  if (sock) {
    try { sock.ws.close(); } catch (_) {}
    try { sock.ev.removeAllListeners(); } catch (_) {}
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const isConnected = state?.creds?.me || state?.creds?.registered;
  const wantsPairing = process.argv.includes('--pair');
  const wantsQr = process.argv.includes('--qr');
  if (!isConnected && !wantsPairing && !wantsQr) {
    console.log('\n⚠️ Nenhuma sessão ativa encontrada.');
    console.log('👉 Para conectar seu WhatsApp via QR Code: node index.js --qr');
    console.log('👉 Para conectar seu WhatsApp via Código:  node index.js --pair\n');
    console.log('💤 Entrando em modo de espera inativo para evitar reinicializações em loop no PM2...');
    setInterval(() => {}, 24 * 60 * 60 * 1000); // Mantém o processo vivo sem uso de CPU
    return;
  }

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    emitOwnEvents: true,
    fireInitQueries: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 180000,
    keepAliveIntervalMs: 30000,
    defaultQueryTimeoutMs: 60000,
    getMessage: async () => undefined,
  });

  // Salvar credenciais ANTES do pairing
  sock.ev.on('creds.update', saveCreds);

  // ─── PAIRING CODE (apenas se --pair for passado) ───
  if (!state.creds.registered && wantsPairing) {
    const requestPairing = async (attempt = 1) => {
      if (sock.authState.creds.registered) return;
      try {
        const cleanPhone = MEU_NUMERO.replace(/[^0-9]/g, '');
        console.log(`⏳ [PAIRING] Solicitando código para +${cleanPhone} (Tentativa ${attempt}/5)...`);
        const code = await sock.requestPairingCode(cleanPhone);
        const codeFormatado = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n╔══════════════════════════════════════════╗');
        console.log('║       📲 CÓDIGO DE PAREAMENTO            ║');
        console.log('║                                          ║');
        console.log(`║            ${codeFormatado}                  ║`);
        console.log('║                                          ║');
        console.log('║  No WhatsApp:                            ║');
        console.log('║  ⋮ > Aparelhos conectados                ║');
        console.log('║  > Conectar aparelho                     ║');
        console.log('║  > Conectar com número de telefone       ║');
        console.log('║  > Inserir código acima                  ║');
        console.log('╚══════════════════════════════════════════╝\n');
      } catch (err) {
        console.error(`[PAIRING] Erro (Tentativa ${attempt}/5):`, err.message);
        if (attempt < 5) {
          console.log('[PAIRING] Aguardando 5s antes de tentar novamente...');
          pairingTimeoutHandle = setTimeout(() => requestPairing(attempt + 1), 5000);
        } else {
          console.error('[PAIRING] Falha total após 5 tentativas.');
        }
      }
    };
    // Espera estabilização do WebSocket antes de solicitar o código (5s)
    pairingTimeoutHandle = setTimeout(() => requestPairing(1), 5000);
  }

  // ─── CONEXÃO ─────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state.creds.registered && wantsQr) {
      const QRCode = require('qrcode');
      console.log('\n📲 [QR CODE GERADO] Escaneie o QR Code abaixo no WhatsApp:\n');
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
        if (!err) console.log(url);
      });
      // Salva arquivo HTML local igual a Nazuna
      const htmlContent = `<html><head><meta http-equiv="refresh" content="3"><style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5;font-family:sans-serif;}</style></head><body><div style="background:#fff;padding:24px;border-radius:12px;text-align:center;"><h2>🤖 Escaneie com WhatsApp</h2><div id="q"></div></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById("q"),{text:"${qr}",width:256,height:256});</script></body></html>`;
      try { fs.writeFileSync(path.join(__dirname, 'qrcode.html'), htmlContent); } catch (_) {}
    }

    if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
      startTime = Date.now();
      // Limpa timeout de pairing se ainda existir
      if (pairingTimeoutHandle) {
        clearTimeout(pairingTimeoutHandle);
        pairingTimeoutHandle = null;
      }
      
      if (wantsPairing || wantsQr) {
        console.log('\n🎉 Conectado com sucesso! Sessão ativa.');
      }

      if (modoAtivo) iniciarPresenca();

      // Reconectar instâncias de sub-bots salvas
      subbotManager.reconectarSubbotsSalvos().catch(err => {
        console.error('Erro ao reconectar subbots salvos:', err.message);
      });
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️ Conexão fechada. Razão: ${reason}`);

      // Em modo de pareamento, o WhatsApp fecha a conexão enquanto o usuário digita o código (428/408).
      // NÃO matar a sessão nem reconectar imediatamente para não invalidar o código digitado!
      if (wantsPairing && (reason === 428 || reason === 408)) {
        console.log('⏳ O código acima continua válido por ~2 minutos. Insira o código no WhatsApp.');
        return;
      }

      if (reason === DisconnectReason.loggedOut || (reason === 401 && !wantsPairing)) {
        console.log('❌ Sessão encerrada (logout/401). Apagando pasta session-presenca...');
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
        process.exit(0);
      }

      // Reconexão automática
      console.log('🔄 Reconectando em 5s...');
      setTimeout(conectar, 5000);
    }
  });

  // Função auxiliar para extrair texto de qualquer tipo de mensagem Baileys
  const extrairTexto = (m) => {
    if (!m) return '';
    const msg = m.ephemeralMessage?.message ||
                m.viewOnceMessage?.message ||
                m.viewOnceMessageV2?.message ||
                m.documentWithCaptionMessage?.message ||
                m;
    return (
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      msg.documentMessage?.caption ||
      msg.buttonsResponseMessage?.selectedButtonId ||
      msg.templateButtonReplyMessage?.selectedId ||
      msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
      ''
    ).trim();
  };

  // ─── MENSAGENS ───────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remetente = msg.key.remoteJid;
      if (!remetente || remetente === 'status@broadcast') continue;

      const isFromMe = !!msg.key.fromMe;
      const isGroup = remetente.endsWith('@g.us');
      const senderJid = msg.key.participant || remetente || '';
      const userPhone = senderJid.replace(/[^0-9]/g, '');
      const isDono = isFromMe || DONOS.some(d => d.replace(/[^0-9]/g, '') === userPhone);

      // Anti-duplicação: ignorar mensagem já processada
      const msgId = msg.key.id;
      if (processedMsgs.has(msgId)) continue;
      processedMsgs.add(msgId);
      if (processedMsgs.size > MAX_CACHE) {
        const arr = [...processedMsgs];
        arr.splice(0, arr.length - 100).forEach(id => processedMsgs.delete(id));
      }

      const rawTexto = extrairTexto(msg.message).replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').trim();
      const texto = rawTexto.toLowerCase().trim();

      if (!texto) continue;

      console.log(`📩 [MSG] De: ${remetente} (grupo: ${isGroup}) | fromMe: ${isFromMe} | texto: "${rawTexto}"`);

      const prefix = subbotManager.getPrefixo();

      // PROTEÇÃO ANTI-LOOP: O bot nunca processa mensagens enviadas por ele mesmo,
      // a não ser que comecem com o prefixo (comandos do dono direto no celular).
      if (isFromMe && !texto.startsWith(prefix)) {
        continue;
      }

      // ─── COMANDO !MENU (Público para todos os membros) ─
      if (texto === `${prefix}menu` || texto.startsWith(`${prefix}menu `)) {
        await sock.readMessages([msg.key]).catch(() => {});
        const senderPushName = msg.pushName || (isFromMe ? 'Dono' : 'Membro');
        const vagasLivres = subbotManager.getLimiteMaximo() - subbotManager.getAtivosCount();

        let menuMsg = `╭┈⊰ ⚡ 『 *BOT ONLINE* 』\n`;
        menuMsg += `┊Olá, ${senderPushName}!\n`;
        menuMsg += `╰─┈┈┈┈┈◜❁◞┈┈┈┈┈─╯\n\n`;

        menuMsg += `╭┈❁ *⚡ SUB-BOTS & CONEXÃO*\n`;
        menuMsg += `┊\n`;
        menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}conectar\n`;
        menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}desconectar\n`;
        menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}cancelar\n`;
        menuMsg += `┊\n`;
        menuMsg += `┊📊 Vagas disponíveis: ${vagasLivres}/${subbotManager.getLimiteMaximo()}\n`;
        menuMsg += `╰─┈┈┈┈┈◜❁◞┈┈┈┈┈─╯\n\n`;

        menuMsg += `╭┈❁ *ℹ️ INFORMAÇÕES*\n`;
        menuMsg += `┊\n`;
        menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}menu\n`;
        menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}bot\n`;
        menuMsg += `╰─┈┈┈┈┈◜❁◞┈┈┈┈┈─╯`;

        if (isDono) {
          menuMsg += `\n\n╭┈❁ *👑 PAINEL DO DONO*\n`;
          menuMsg += `┊\n`;
          menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}subbots\n`;
          menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}setlimite <n>\n`;
          menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}delsubbot <id>\n`;
          menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}setprefixo <pref>\n`;
          menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}on\n`;
          menuMsg += `┊•.̇𖥨֗⚡⭟${prefix}off\n`;
          menuMsg += `╰─┈┈┈┈┈◜❁◞┈┈┈┈┈─╯`;
        }

        await sock.sendMessage(remetente, { text: menuMsg }, { quoted: msg }).catch(async (err) => {
          console.error('⚠️ Falha ao responder com quoted, tentando direto:', err.message);
          await sock.sendMessage(remetente, { text: menuMsg }).catch(e => console.error('❌ Erro fatal ao enviar menu:', e.message));
        });
        console.log(`✅ Menu enviado com sucesso para ${remetente}`);
        continue;
      }

      // ─── COMANDOS DE DONO ─────────────────────────────
      if (isDono) {
        // Trocar prefixo dinamicamente (!setprefixo <novo>)
        if (texto.startsWith(`${prefix}setprefixo`)) {
          await sock.readMessages([msg.key]).catch(() => {});
          const partes = rawTexto.split(/\s+/);
          const novoPref = partes[1]?.trim();
          if (!novoPref || novoPref.length > 3) {
            await sock.sendMessage(remetente, {
              text: `⚠️ *Uso correto:* \`${prefix}setprefixo <novo_prefixo>\`\nExemplo: \`${prefix}setprefixo !\` ou \`${prefix}setprefixo #\``
            }, { quoted: msg });
            continue;
          }

          subbotManager.setPrefixo(novoPref);
          await sock.sendMessage(remetente, {
            text: `✅ *Prefixo atualizado com sucesso!*\n\n• Novo prefixo ativo: *${novoPref}*\nExemplo de comando: *${novoPref}menu* ou *${novoPref}conectar*`
          }, { quoted: msg });
          continue;
        }

        if (texto === `${prefix}on`) {
          await sock.readMessages([msg.key]).catch(() => {});
          modoAtivo = true;
          salvarEstado();
          iniciarPresenca();
          await sock.sendMessage(remetente, { text: '✅ *Modo 24/7 ATIVADO*\n\n• Presença online' }, { quoted: msg });
          continue;
        }

        if (texto === `${prefix}off`) {
          await sock.readMessages([msg.key]).catch(() => {});
          modoAtivo = false;
          salvarEstado();
          pararPresenca();
          await sock.sendMessage(remetente, { text: '⛔ *Modo 24/7 DESATIVADO*\n\n• Presença offline' }, { quoted: msg });
          continue;
        }

        if (texto === `${prefix}bot`) {
          await sock.readMessages([msg.key]).catch(() => {});
          const uptime = formatUptime(Date.now() - startTime);
          const mem = process.memoryUsage();
          const rss = (mem.rss / 1024 / 1024).toFixed(1);
          const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);

          const status = [
            '🤖 *Bot Presença - Status*',
            '',
            `⏱️ *Uptime:* ${uptime}`,
            `📡 *Modo:* ${modoAtivo ? '🟢 ON (24/7)' : '🔴 OFF (Normal)'}`,
            `⚡ *Prefixo:* \`${prefix}\``,
            `🔗 *Conexão:* ✅ Conectado`,
            `💾 *RAM:* ${rss} MB (heap: ${heap} MB)`,
            `👥 *Sub-Bots:* ${subbotManager.getAtivosCount()}/${subbotManager.getLimiteMaximo()} ativos`,
            `🖥️ *Plataforma:* ${process.platform} ${process.arch}`,
            `📦 *Node:* ${process.version}`,
          ].join('\n');

          await sock.sendMessage(remetente, { text: status }, { quoted: msg });
          continue;
        }

        // Listar sub-bots conectados
        if (texto === `${prefix}subbots` || texto === `${prefix}listarsub`) {
          await sock.readMessages([msg.key]).catch(() => {});
          const lista = subbotManager.listarSubbots();
          await sock.sendMessage(remetente, { text: lista }, { quoted: msg });
          continue;
        }

        // Alterar limite de sub-bots (!setlimite 5)
        if (texto.startsWith(`${prefix}setlimite`)) {
          await sock.readMessages([msg.key]).catch(() => {});
          const partes = rawTexto.split(/\s+/);
          const novoLimite = parseInt(partes[1], 10);
          if (isNaN(novoLimite) || novoLimite < 0) {
            await sock.sendMessage(remetente, { text: `⚠️ *Uso correto:* \`${prefix}setlimite <número>\`\nExemplo: \`${prefix}setlimite 3\`` }, { quoted: msg });
            continue;
          }

          subbotManager.setLimiteMaximo(novoLimite);
          await sock.sendMessage(remetente, {
            text: `✅ *Limite atualizado com sucesso!*\n\n• Novo limite de conexões: *${novoLimite}* sub-bots`
          }, { quoted: msg });
          continue;
        }

        // Deletar / Desconectar subbot por ID (!delsubbot 1)
        if (texto.startsWith(`${prefix}delsubbot`)) {
          await sock.readMessages([msg.key]).catch(() => {});
          const partes = rawTexto.split(/\s+/);
          const idSub = partes[1];
          if (!idSub) {
            await sock.sendMessage(remetente, { text: `⚠️ *Uso correto:* \`${prefix}delsubbot <id>\`\nConsulte os IDs com \`${prefix}subbots\`.` }, { quoted: msg });
            continue;
          }

          const removido = await subbotManager.deletarSubbot(idSub);
          if (removido) {
            await sock.sendMessage(remetente, { text: `✅ *Sub-bot [${idSub}] desconectado e removido com sucesso!*` }, { quoted: msg });
          } else {
            await sock.sendMessage(remetente, { text: `❌ Sub-bot com ID \`${idSub}\` não foi encontrado.` }, { quoted: msg });
          }
          continue;
        }
      }

      // ─── CANCELAR CONEXÃO EM ANDAMENTO ───────────────
      if (texto === `${prefix}cancelar`) {
        const userKey = isGroup ? senderJid : remetente;
        if (!isFromMe && subbotManager.connectingStates.has(userKey)) {
          const estado = subbotManager.connectingStates.get(userKey);
          if (estado.id) await subbotManager.deletarSubbot(estado.id);
          subbotManager.limparEstado(userKey);
          await sock.readMessages([msg.key]).catch(() => {});
          await sock.sendMessage(remetente, { text: '❌ *Processo de conexão cancelado com sucesso.*' }, { quoted: msg });
          continue;
        }
      }

      // ─── DESCONECTAR PRÓPRIO SUB-BOT ──────────────────
      if (texto === `${prefix}desconectar` || texto === `${prefix}desconectarsub`) {
        await sock.readMessages([msg.key]).catch(() => {});
        const userKey = isGroup ? senderJid : remetente;
        const meuSub = subbotManager.getSubbotPorUsuario(userKey);
        if (!meuSub) {
          await sock.sendMessage(remetente, { text: 'ℹ️ Você não possui nenhum sub-bot conectado no momento.' }, { quoted: msg });
          continue;
        }

        await subbotManager.deletarSubbot(meuSub.id);
        await sock.sendMessage(remetente, { text: `✅ *Seu sub-bot (ID ${meuSub.id}) foi desconectado e removido com sucesso.*` }, { quoted: msg });
        continue;
      }

      // ─── FLUXO CONVERSACIONAL DE CONEXÃO ──────────────
      // Identifica o estado pelo usuário específico (nunca para mensagens enviadas pelo próprio bot)
      const userKey = isGroup ? senderJid : remetente;
      const estadoConexao = !isFromMe ? subbotManager.connectingStates.get(userKey) : null;

      if (estadoConexao) {
        const targetChat = estadoConexao.chatJid || remetente;

        // ETAPA 1: Escolha do método (1 = QR Code, 2 = Pairing Code)
        if (estadoConexao.step === 'ESCOLHER_METODO') {
          if (texto === '1') {
            await sock.readMessages([msg.key]).catch(() => {});
            // QR CODE
            estadoConexao.step = 'PROCESSANDO_QR';
            estadoConexao.method = '1';
            const subId = subbotManager.gerarProximoId();
            estadoConexao.id = subId;

            await sock.sendMessage(targetChat, {
              text: '⏳ *Gerando QR Code...*\nPor favor, aguarde alguns instantes.'
            }, { quoted: msg });

            subbotManager.iniciarConexao({
              id: subId,
              userJid: userKey,
              method: '1',
              onQRCode: async (buffer) => {
                await sock.sendMessage(targetChat, {
                  image: buffer,
                  caption: '📲 *Aponte seu WhatsApp para conectar!*\n\n• Abra o WhatsApp > Aparelhos Conectados > Conectar um aparelho.\n⏱️ Você tem 1 minuto para escanear.'
                }, { quoted: msg });
              },
              onConnected: async (phoneConectado) => {
                subbotManager.limparEstado(userKey);
                await sock.sendMessage(targetChat, {
                  text: `🎉 *Conexão estabelecida com sucesso!*\n\n• Sub-Bot ID: \`${subId}\`\n• Número: \`${phoneConectado}\`\n• Status: 🟢 Ativo 24/7\n\nCaso queira desconectar, envie *${prefix}desconectar*.`
                }, { quoted: msg });
              },
              onError: async (errMsg) => {
                subbotManager.limparEstado(userKey);
                await subbotManager.deletarSubbot(subId);
                await sock.sendMessage(targetChat, {
                  text: `❌ *Falha na conexão do Sub-Bot:*\n${errMsg}\n\nEnvie *${prefix}conectar* para tentar novamente.`
                }, { quoted: msg });
              }
            });
            continue;
          } else if (texto === '2') {
            await sock.readMessages([msg.key]).catch(() => {});
            // PAIRING CODE
            estadoConexao.step = 'AGUARDANDO_NUMERO';
            estadoConexao.method = '2';

            await sock.sendMessage(targetChat, {
              text: '📱 *Envie seu número de telefone com DDI e DDD:*\n\nExemplo: `5511999999999` ou `258879116693`\n*(Digite apenas números ou com +)*'
            }, { quoted: msg });
            continue;
          } else {
            // Em grupos, se for mensagem normal de conversa, não enviar erro para não poluir o grupo.
            if (!isGroup || texto.length <= 3) {
              await sock.sendMessage(targetChat, {
                text: `⚠️ *Opção inválida!*\n\nPor favor, responda apenas:\n*1* - Para QR Code\n*2* - Para Código de Pareamento\n\n_(Envie *${prefix}cancelar* para desistir)_`
              }, { quoted: msg });
            }
            continue;
          }
        }

        // ETAPA 2: Recebendo o número para Pairing Code
        if (estadoConexao.step === 'AGUARDANDO_NUMERO') {
          const cleanPhone = rawTexto.replace(/[^0-9]/g, '');

          if (cleanPhone.length < 8 || cleanPhone.length > 16) {
            if (!isGroup || cleanPhone.length > 0) {
              await sock.sendMessage(targetChat, {
                text: `⚠️ *Número inválido!*\nCertifique-se de incluir o DDI e DDD (ex: \`5511999999999\` ou \`258855954127\`). Tente novamente ou envie *${prefix}cancelar*.`
              }, { quoted: msg });
            }
            continue;
          }

          await sock.readMessages([msg.key]).catch(() => {});
          estadoConexao.step = 'PROCESSANDO_CODE';
          estadoConexao.phone = cleanPhone;
          const subId = subbotManager.gerarProximoId();
          estadoConexao.id = subId;

          await sock.sendMessage(targetChat, {
            text: `⏳ *Solicitando código de pareamento para o número +${cleanPhone}...*\nAguarde alguns segundos.`
          }, { quoted: msg });

          subbotManager.iniciarConexao({
            id: subId,
            userJid: userKey,
            method: '2',
            phone: cleanPhone,
            onPairingCode: async (code) => {
              const codeFormatado = code?.match(/.{1,4}/g)?.join('-') || code;
              await sock.sendMessage(targetChat, {
                text: `📲 *SEU CÓDIGO DE PAREAMENTO:*\n\n#️⃣ \`${codeFormatado}\`\n\n*Como conectar:* \n1. Abra o WhatsApp no celular.\n2. Toque em ⋮ > *Aparelhos conectados*.\n3. Toque em *Conectar um aparelho* > *Conectar com número de telefone*.\n4. Insira o código acima.\n\n⏱️ Aguardando confirmação...`
              }, { quoted: msg });
            },
            onConnected: async (phoneConectado) => {
              subbotManager.limparEstado(userKey);
              await sock.sendMessage(targetChat, {
                text: `🎉 *Conexão estabelecida com sucesso!*\n\n• Sub-Bot ID: \`${subId}\`\n• Número: \`${phoneConectado}\`\n• Status: 🟢 Ativo 24/7\n\nCaso queira desconectar futuramente, envie *${prefix}desconectar*.`
              }, { quoted: msg });
            },
            onError: async (errMsg) => {
              subbotManager.limparEstado(userKey);
              await subbotManager.deletarSubbot(subId);
              await sock.sendMessage(targetChat, {
                text: `❌ *Falha na conexão do Sub-Bot:*\n${errMsg}\n\nEnvie *${prefix}conectar* para tentar novamente.`
              }, { quoted: msg });
            }
          });
          continue;
        }
      }

      // ─── COMANDO CONECTAR (Grupos e PV) ──────────────
      if (texto === `${prefix}conectar`) {
        await sock.readMessages([msg.key]).catch(() => {});
        const userKey = isGroup ? senderJid : remetente;

        // 1. Verificar se o usuário já tem um subbot ativo
        const subExistente = subbotManager.getSubbotPorUsuario(userKey);
        if (subExistente) {
          await sock.sendMessage(remetente, {
            text: `⚠️ *Você já possui um sub-bot ativo!*\n\n• ID: \`${subExistente.id}\`\n• Número: \`${subExistente.phone}\`\n\nPara desconectar seu bot anterior e criar um novo, envie *${prefix}desconectar*.`
          }, { quoted: msg });
          continue;
        }

        // 2. Verificar se há vagas disponíveis
        if (!subbotManager.temVaga()) {
          const ativos = subbotManager.getAtivosCount();
          const limite = subbotManager.getLimiteMaximo();
          await sock.sendMessage(remetente, {
            text: `🚫 *Limite de conexões atingido!*\n\nNo momento, todas as vagas estão ocupadas (${ativos}/${limite} ativas).\nTente novamente mais tarde.`
          }, { quoted: msg });
          continue;
        }

        // 3. Iniciar fluxo de escolha de método
        const timeoutHandle = setTimeout(async () => {
          if (subbotManager.connectingStates.has(userKey)) {
            const estado = subbotManager.connectingStates.get(userKey);
            if (estado.id) await subbotManager.deletarSubbot(estado.id);
            subbotManager.limparEstado(userKey);
            await sock.sendMessage(remetente, {
              text: '⏱️ *Tempo esgotado:* Processo de conexão cancelado por inatividade.'
            }, { quoted: msg }).catch(() => {});
          }
        }, 120000); // 2 minutos de timeout

        subbotManager.connectingStates.set(userKey, {
          step: 'ESCOLHER_METODO',
          chatJid: remetente,
          userJid: userKey,
          timeoutHandle
        });

        const ativos = subbotManager.getAtivosCount();
        const limite = subbotManager.getLimiteMaximo();

        const menuEscolha = [
          '⚡ *SISTEMA DE SUB-BOTS*',
          '',
          `📊 *Vagas disponíveis:* ${limite - ativos} de ${limite}`,
          '',
          'Escolha como deseja conectar:',
          '*[1]* 📷 QR Code',
          '*[2]* 🔢 Código de Pareamento',
          '',
          '👉 *Responda apenas com "1" ou "2".*',
          `_(Envie *${prefix}cancelar* a qualquer momento para desistir)_`
        ].join('\n');

        await sock.sendMessage(remetente, { text: menuEscolha }, { quoted: msg });
        continue;
      }
    }
  });
}

// ─── UTILS ───────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

// ─── INICIAR ─────────────────────────────────────────────
console.log('🚀 Iniciando Bot Presença...');
conectar().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
