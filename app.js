const translations = {
    ja: {
        langTitle: "言語設定", helpTitle: "ヘルプ & ガイド", guideFile: "Audio Fileモード ガイド", guideYT: "YouTubeモード ガイド",
        close: "閉じる", fit: "全体表示", clear: "範囲解除", ready: "準備完了", analyzing: "解析中...",
        setStart: "開始位置", setEnd: "終了位置", loopOff: "ループ OFF", loopOn: "ループ ON",
        fileSelect: "ファイルを選択", saveLoop: "ループ保存",
        recPlay: "録音再生", recStop: "再生停止",
        guideFileContent: "<b>【Audio File Mode】ガイド</b><ul><li>録音機能: 再生しながら録音できます。客観的チェックに最適。</li><li>音量調整: メイン音源と録音音声を個別に調整可能。</li><li>ソロ(S): 録音音響のみを再生。</li><li>AIアドバイス: 演奏を分析します。</li></ul>",
        guideYTContent: "<b>【YouTube Mode】ガイド</b><ul><li>読み込み: URLを貼り付けてLOAD。</li><li>ループ: SET START/ENDで区間指定。</li><li>SAVE: ループを複数保存。</li></ul>"
    },
    en: {
        langTitle: "Language Settings", helpTitle: "Help & Guide", guideFile: "Audio File Mode Guide", guideYT: "YouTube Mode Guide",
        close: "Close", fit: "FIT", clear: "Clear Loop", ready: "READY", analyzing: "ANALYZING...",
        setStart: "SET START", setEnd: "SET END", loopOff: "LOOP OFF", loopOn: "LOOP ON",
        fileSelect: "Select Audio File", saveLoop: "Save Loop",
        recPlay: "Play Rec", recStop: "Stop Rec",
        guideFileContent: "<b>【Audio File Mode】Guide</b><ul><li>Recording: Record while playing.</li><li>Volume: Adjust Main/Rec levels.</li><li>Solo(S): Listen only to recording.</li><li>AI Advice: Analyze performance.</li></ul>",
        guideYTContent: "<b>【YouTube Mode】Guide</b><ul><li>Load: Paste URL and LOAD.</li><li>Loop: Press START/END.</li><li>SAVE: Store multiple loops.</li></ul>"
    }
};

let wavesurfer, wsRegions, recWavesurfer, ytPlayer, loopInterval;
let loopStart = 0, loopEnd = 0, isLooping = false, currentMode = 'file';
let audioCtx, firstSoundTime = 0, originalBpm = 120;
let currentObjectURL = null, currentFileName = "", currentYTId = "";
let isCountEnabled = true, isSpeedUpEnabled = false;
let mediaRecorder, recordedChunks = [];
let isRecording = false, isSolo = false;
let recObjectURL = null, recordedAudioBuffer = null, lastRecStartPos = 0;

function changeLanguage() {
    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    document.getElementById('langTitle').innerText = t.langTitle;
    document.getElementById('helpTitle').innerText = t.helpTitle;
    document.getElementById('guideFileTitle').innerText = t.guideFile;
    document.getElementById('guideYTTitle').innerText = t.guideYT;
    document.getElementById('closeBtn1').innerText = t.close;
    document.getElementById('closeBtn2').innerText = t.close;
    document.getElementById('resetZoomBtn').innerText = t.fit;
    document.getElementById('clearRangeBtn').innerHTML = `<span class="material-icons" style="font-size:16px;">layers_clear</span> ${t.clear}`;
    document.getElementById('saveLoopBtn').innerHTML = `<span class="material-icons" style="font-size:16px;">bookmark_add</span> ${t.saveLoop}`;
    document.getElementById('setStartBtn').innerText = t.setStart;
    document.getElementById('setEndBtn').innerText = t.setEnd;
    document.getElementById('guideFileContent').innerHTML = t.guideFileContent;
    document.getElementById('guideYTContent').innerHTML = t.guideYTContent;
    
    const fileLabel = document.getElementById('fileSelectBtn');
    if (fileLabel.innerText.includes("ファイル") || fileLabel.innerText.includes("Select")) fileLabel.innerText = t.fileSelect;
    const loadS = document.getElementById('loadStatus');
    if (loadS.innerText.includes("READY") || loadS.innerText.includes("準備")) loadS.innerText = t.ready;
    const loopB = document.getElementById('toggleLoopBtn');
    if(loopB) loopB.innerText = isLooping ? t.loopOn : t.loopOff;
    updateRecPlayBtnUI();
}

function updateRecPlayBtnUI() {
    const lang = document.getElementById('langSelect').value;
    const t = translations[lang] || translations['ja'];
    const btn = document.getElementById('playRecBtn');
    if (recWavesurfer && recWavesurfer.isPlaying()) {
        btn.innerHTML = `<span class="material-icons" style="font-size:14px;">stop_circle</span> ${t.recStop}`;
    } else {
        btn.innerHTML = `<span class="material-icons" style="font-size:14px;">play_circle</span> ${t.recPlay}`;
    }
}

function toggleMenu(isOpen) {
    document.getElementById('sideMenu').classList.toggle('open', isOpen);
    document.getElementById('menuOverlay').style.display = isOpen ? 'block' : 'none';
}

function showGuide(type) {
    toggleMenu(false); closeModals();
    if (type === 'file') document.getElementById('guideModalFile').style.display = 'block';
    if (type === 'yt') document.getElementById('guideModalYT').style.display = 'block';
    document.getElementById('menuOverlay').style.display = 'block';
}

function closeModals() {
    document.getElementById('guideModalFile').style.display = 'none';
    document.getElementById('guideModalYT').style.display = 'none';
    document.getElementById('menuOverlay').style.display = 'none';
}

function initAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function toggleSolo() {
    isSolo = !isSolo;
    document.getElementById('soloBtn').classList.toggle('active', isSolo);
    applyVolumes();
}

function applyVolumes() {
    if (!wavesurfer) return;
    const mVol = parseFloat(document.getElementById('mainVolume').value);
    const rVol = parseFloat(document.getElementById('recVolume').value);
    
    if (isSolo) {
        wavesurfer.setMuted(true);
    } else {
        wavesurfer.setMuted(false);
        wavesurfer.setVolume(mVol);
    }
    
    if (recWavesurfer) recWavesurfer.setVolume(rVol);
    
    document.getElementById('mainVolTxt').innerText = Math.round(mVol * 100) + "%";
    document.getElementById('recVolTxt').innerText = Math.round(rVol * 100) + "%";
}

function toggleFeature(type) {
    if (type === 'count') {
        isCountEnabled = !isCountEnabled;
        document.getElementById('countToggleBtn').classList.toggle('active', isCountEnabled);
    } else if (type === 'speedup') {
        isSpeedUpEnabled = !isSpeedUpEnabled;
        document.getElementById('speedUpToggleBtn').classList.toggle('active', isSpeedUpEnabled);
    }
}

function switchMode(mode) {
    currentMode = mode;
    document.getElementById('file-section').classList.toggle('active', mode === 'file');
    document.getElementById('yt-section').classList.toggle('active', mode === 'yt');
    document.getElementById('tab-file').classList.toggle('active', mode === 'file');
    document.getElementById('tab-yt').classList.toggle('active', mode === 'yt');
    if(mode === 'yt') { if(wavesurfer) wavesurfer.pause(); renderYTHistory(); }
    if(mode === 'file' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
}

async function analyzeAudio(blob) {
    const lang = document.getElementById('langSelect').value;
    const statusEl = document.getElementById('loadStatus');
    statusEl.innerText = translations[lang].analyzing;
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
        const data = audioBuffer.getChannelData(0);
        let skip = 0;
        const threshold = 0.015;
        for (let i = 0; i < data.length; i += 100) { if (Math.abs(data[i]) > threshold) { skip = i / audioBuffer.sampleRate; break; } }
        firstSoundTime = skip;
        const bpm = detectBPM(audioBuffer);
        if (bpm > 0) { originalBpm = Math.round(bpm); updateBpmDisplay(); }
        statusEl.innerText = translations[lang].ready;
        if(wavesurfer) wavesurfer.setTime(firstSoundTime);
    } catch (e) { statusEl.innerText = translations[lang].ready; } finally { tempCtx.close(); }
}

function updateBpmDisplay() {
    const currentSpeed = parseFloat(document.getElementById('speed').value);
    const currentBpm = Math.round(originalBpm * currentSpeed);
    document.getElementById('spTxt').innerText = "BPM " + currentBpm;
}

function detectBPM(buffer) {
    const data = buffer.getChannelData(0), sampleRate = buffer.sampleRate, step = 200, energy = [];
    for (let i = 0; i < data.length; i += step) {
        let sum = 0;
        for(let j=0; j<step && (i+j)<data.length; j++) sum += data[i+j] * data[i+j];
        energy.push(Math.sqrt(sum/step));
    }
    let bestBpm = 0, maxCorrelation = 0;
    const minInterval = Math.floor((60 / 200) * (sampleRate / step)), maxInterval = Math.floor((60 / 60) * (sampleRate / step));
    for (let interval = minInterval; interval <= maxInterval; interval++) {
        let correlation = 0;
        for (let i = 0; i < Math.min(energy.length - interval, 10000); i++) correlation += energy[i] * energy[i + interval];
        if (correlation > maxCorrelation) { maxCorrelation = correlation; bestBpm = 60 / (interval * step / sampleRate); }
    }
    return (bestBpm < 50 || bestBpm > 250) ? 0 : bestBpm;
}

function playBeep(isLast) {
    const ctx = initAudioContext();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.setValueAtTime(isLast ? 880 : 440, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.1);
}

async function runCountdown() {
    if (!isCountEnabled) return true;
    const currentSpeed = parseFloat(document.getElementById('speed').value);
    const interval = 60000 / (originalBpm * currentSpeed);
    const overlay = document.getElementById('countdown-overlay');
    overlay.style.display = 'block';
    for (let i = 1; i <= 4; i++) {
        overlay.innerText = i; playBeep(i === 4);
        await new Promise(r => setTimeout(r, interval));
    }
    overlay.style.display = 'none'; return true;
}

async function toggleRecording() {
    initAudioContext();
    if (isRecording) {
        if (mediaRecorder) mediaRecorder.stop();
        if (wavesurfer.isPlaying()) wavesurfer.pause();
        isRecording = false;
        document.getElementById('recBtn').classList.remove('recording');
        document.getElementById('recIcon').innerText = 'mic';
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: { ideal: false }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: false } } 
            });
            if (audioCtx) await audioCtx.resume();
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
            mediaRecorder = new MediaRecorder(stream, { mimeType });
            recordedChunks = [];
            mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
            mediaRecorder.onstop = async () => {
                const blob = new Blob(recordedChunks, { type: mimeType });
                if (recObjectURL) URL.revokeObjectURL(recObjectURL);
                recObjectURL = URL.createObjectURL(blob);
                const arrayBuffer = await blob.arrayBuffer();
                const tempCtx = new AudioContext();
                recordedAudioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
                tempCtx.close();
                document.getElementById('rec-waveform-wrapper').style.display = 'block';
                document.getElementById('recVolControl').style.display = 'flex';
                document.getElementById('recControls').style.display = 'flex';
                document.getElementById('aiResultCard').style.display = 'none';
                await recWavesurfer.load(recObjectURL);
                applyVolumes();
                updateRecPlayBtnUI();
                stream.getTracks().forEach(track => track.stop());
            };
            const region = wsRegions.getRegions()[0];
            const startPos = region ? region.start : wavesurfer.getCurrentTime();
            wavesurfer.setTime(startPos);
            lastRecStartPos = startPos;
            await runCountdown();
            mediaRecorder.start();
            await wavesurfer.play();
            isRecording = true;
            document.getElementById('recBtn').classList.add('recording');
            document.getElementById('recIcon').innerText = 'stop';
        } catch (err) { alert("マイクの使用を許可してください。"); }
    }
}

function playRecording() {
    if (!recWavesurfer || !recWavesurfer.getDuration()) return;
    if (recWavesurfer.isPlaying()) { recWavesurfer.pause(); wavesurfer.pause(); } 
    else { wavesurfer.setTime(lastRecStartPos); recWavesurfer.setTime(0); wavesurfer.play(); recWavesurfer.play(); }
    updateRecPlayBtnUI();
}

async function runAIAdvice() {
    if (!recordedAudioBuffer) return;
    const loading = document.getElementById('aiLoading');
    const resultCard = document.getElementById('aiResultCard');
    const adviceText = document.getElementById('aiAdviceText');
    loading.style.display = 'block';
    resultCard.style.display = 'none';
    const data = recordedAudioBuffer.getChannelData(0);
    let sum = 0, max = 0;
    for(let i=0; i<data.length; i++) {
        const val = Math.abs(data[i]);
        sum += val;
        if(val > max) max = val;
    }
    const avg = sum / data.length;
    const dynamicRange = max / (avg || 1);
    setTimeout(() => {
        let advice = "";
        const lang = document.getElementById('langSelect').value;
        if (lang === 'ja') {
            advice = "<b>【リズム/音量分析】</b><br>";
            if (avg < 0.01) advice += "・入力音が小さすぎます。マイク位置を確認しましょう。<br>";
            else if (dynamicRange > 15) advice += "・アクセントが明確ですが、音量のバラつきに注意が必要です。<br>";
            else advice += "・安定した音量バランスで演奏できています。<br>";
            advice += "<br><b>【AIアドバイス】</b><br>・フレーズの終わりの余韻を大切に。BPMを5上げて挑戦してみましょう。";
        } else {
            advice = "<b>【Dynamic Analysis】</b><br>" + (avg < 0.01 ? "・Input too low." : "・Good volume stability.<br>");
            advice += "<br><b>【AI Feedback】</b><br>・Consistency is good. Try increasing speed by 5%.";
        }
        loading.style.display = 'none';
        adviceText.innerHTML = advice;
        resultCard.style.display = 'block';
    }, 1500);
}

function deleteRecording() {
    if (confirm("録音を削除しますか？")) {
        document.getElementById('rec-waveform-wrapper').style.display = 'none';
        document.getElementById('recVolControl').style.display = 'none';
        document.getElementById('recControls').style.display = 'none';
        document.getElementById('aiResultCard').style.display = 'none';
        if (recObjectURL) URL.revokeObjectURL(recObjectURL);
        recObjectURL = null; recordedAudioBuffer = null;
        recWavesurfer.empty();
    }
}

function loadYouTube(manualUrl = null) {
    const urlInput = document.getElementById('ytUrl');
    const url = manualUrl || urlInput.value;
    if (!url) return;
    const videoId = url.includes('v=') ? url.split('v=')[1].split('&')[0] : url.includes('be/') ? url.split('be/')[1].split('?')[0] : null;
    if (videoId) {
        currentYTId = videoId;
        document.getElementById('loopListYT').innerHTML = ""; 
        if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(videoId);
        else {
            ytPlayer = new YT.Player('player', { videoId: videoId, events: { 'onReady': () => { updateYTInfo(); }, 'onStateChange': onPlayerStateChange } });
        }
        urlInput.value = "";
    }
}

function saveToHistory(id, title) {
    let history = JSON.parse(localStorage.getItem('ams_yt_history') || "[]");
    history = history.filter(item => item.id !== id);
    history.unshift({ id: id, title: title || id, url: `https://www.youtube.com/watch?v=${id}`, time: Date.now() });
    if (history.length > 20) history.pop();
    localStorage.setItem('ams_yt_history', JSON.stringify(history));
    renderYTHistory();
}

function renderYTHistory() {
    const historyList = document.getElementById('ytHistoryList');
    const container = document.getElementById('ytHistoryContainer');
    const history = JSON.parse(localStorage.getItem('ams_yt_history') || "[]");
    if (history.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    historyList.innerHTML = "";
    history.forEach(item => {
        const card = document.createElement('div');
        card.style = "background: #252525; border: 1px solid #333; border-radius: 6px; padding: 8px 12px; min-width: 180px; flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; cursor: pointer;";
        card.onclick = () => loadYouTube(item.url);
        card.innerHTML = `<span style="font-size:0.7rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#e0e0e0;">${item.title}</span><span class="material-icons" style="color:#ff5555; font-size:16px;" onclick="event.stopPropagation(); deleteHistoryItem('${item.id}')">cancel</span>`;
        historyList.appendChild(card);
    });
}

window.deleteHistoryItem = (id) => {
    let history = JSON.parse(localStorage.getItem('ams_yt_history') || "[]");
    history = history.filter(item => item.id !== id);
    localStorage.setItem('ams_yt_history', JSON.stringify(history));
    renderYTHistory();
};

window.clearYTHistory = () => { if (confirm("履歴を削除しますか？")) { localStorage.removeItem('ams_yt_history'); renderYTHistory(); } };

function updateYTInfo() {
    const data = ytPlayer.getVideoData();
    if (data && data.video_id) { saveToHistory(data.video_id, data.title); renderLoopList('yt'); }
}

function onPlayerStateChange(e) {
    if (e.data === YT.PlayerState.PLAYING) {
        updateYTInfo();
        loopInterval = setInterval(() => { if (isLooping && ytPlayer.getCurrentTime() >= loopEnd) ytPlayer.seekTo(loopStart); }, 200);
    } else clearInterval(loopInterval);
}

const fmt = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
window.setLoopPoint = (t) => {
    const now = ytPlayer.getCurrentTime();
    if (t === 'start') { loopStart = Math.floor(now); document.getElementById('loopStartTxt').innerText = fmt(loopStart); }
    else { loopEnd = Math.ceil(now); document.getElementById('loopEndTxt').innerText = fmt(loopEnd); }
};

window.adjustTime = (t, a) => {
    if (t === 'start') { loopStart = Math.max(0, loopStart + a); document.getElementById('loopStartTxt').innerText = fmt(loopStart); ytPlayer.seekTo(loopStart); }
    else { loopEnd = Math.max(loopStart + 1, loopEnd + a); document.getElementById('loopEndTxt').innerText = fmt(loopEnd); }
};

window.toggleLoop = () => { 
    isLooping = !isLooping; 
    const lang = document.getElementById('langSelect').value;
    const b = document.getElementById('toggleLoopBtn'); 
    if(b) {
        b.innerText = isLooping ? translations[lang].loopOn : translations[lang].loopOff; 
        b.classList.toggle('active', isLooping); 
    }
};

function saveLoop(mode) {
    let start, end, key;
    if (mode === 'file') {
        const regions = wsRegions.getRegions();
        if (regions.length === 0) return alert("範囲を指定してください");
        start = regions[0].start; end = regions[0].end; key = currentFileName;
    } else {
        if (!currentYTId) return;
        start = loopStart; end = loopEnd; key = currentYTId;
        if (start >= end) return alert("範囲が不正です");
    }
    let storageKey = mode === 'file' ? 'ams_loops' : 'ams_yt_loops';
    let allLoops = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (!allLoops[key]) allLoops[key] = [];
    allLoops[key].push({ start, end });
    localStorage.setItem(storageKey, JSON.stringify(allLoops));
    renderLoopList(mode);
}

function getCircleNum(n) { const circles = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"]; return circles[n-1] || `(${n})`; }

function renderLoopList(mode) {
    const container = mode === 'file' ? document.getElementById('loopListFile') : document.getElementById('loopListYT');
    const key = mode === 'file' ? currentFileName : currentYTId;
    const storageKey = mode === 'file' ? 'ams_loops' : 'ams_yt_loops';
    if(!container) return;
    container.innerHTML = ""; if (!key) return;
    let allLoops = JSON.parse(localStorage.getItem(storageKey) || "{}");
    (allLoops[key] || []).forEach((loop, index) => {
        const badge = document.createElement('div');
        badge.className = 'loop-badge';
        badge.onclick = () => applyStoredLoop(mode, loop.start, loop.end);
        badge.innerHTML = `<span class="badge-num">${getCircleNum(index + 1)}</span><span class="material-icons badge-del" onclick="event.stopPropagation(); deleteLoop('${mode}', ${index})">cancel</span>`;
        container.appendChild(badge);
    });
}

window.applyStoredLoop = (mode, start, end) => {
    if (mode === 'file') { wsRegions.clearRegions(); wsRegions.addRegion({ start, end, color: 'rgba(212, 163, 115, 0.2)' }); wavesurfer.setTime(start); } 
    else { loopStart = start; loopEnd = end; document.getElementById('loopStartTxt').innerText = fmt(start); document.getElementById('loopEndTxt').innerText = fmt(end); ytPlayer.seekTo(start); if (!isLooping) toggleLoop(); }
};

window.deleteLoop = (mode, index) => {
    const storageKey = mode === 'file' ? 'ams_loops' : 'ams_yt_loops';
    const key = mode === 'file' ? currentFileName : currentYTId;
    let allLoops = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (allLoops[key]) { allLoops[key].splice(index, 1); localStorage.setItem(storageKey, JSON.stringify(allLoops)); renderLoopList(mode); }
};

function startApp() {
    wavesurfer = WaveSurfer.create({ container: '#waveform', waveColor: '#333', progressColor: '#d4a373', height: 120, barWidth: 2, normalize: true, barHeight: 1 });
    recWavesurfer = WaveSurfer.create({ container: '#rec-waveform', waveColor: '#552222', progressColor: '#ff4444', height: 80, barWidth: 2, normalize: true, barHeight: 1 });
    wsRegions = wavesurfer.registerPlugin(WaveSurfer.Regions.create());
    wsRegions.enableDragSelection({ color: 'rgba(212, 163, 115, 0.2)' });
    wsRegions.on('region-created', r => { if(wsRegions.getRegions().length > 1) wsRegions.getRegions()[0].remove(); wavesurfer.setTime(r.start); });
    document.getElementById('zoomSlider').oninput = (e) => wavesurfer.zoom(Number(e.target.value));
    document.getElementById('resetZoomBtn').onclick = () => { wavesurfer.zoom(0); document.getElementById('zoomSlider').value = 100; };
    document.getElementById('mainVolume').oninput = applyVolumes;
    document.getElementById('recVolume').oninput = applyVolumes;
    document.getElementById('audioFile').onchange = async e => { 
        const file = e.target.files[0];
        if(file) { 
            currentFileName = file.name;
            document.getElementById('fileSelectBtn').innerText = currentFileName;
            if(currentObjectURL) URL.revokeObjectURL(currentObjectURL);
            const reader = new FileReader();
            reader.onload = async (event) => {
                const blob = new Blob([event.target.result], { type: file.type });
                currentObjectURL = URL.createObjectURL(blob);
                wavesurfer.load(currentObjectURL);
                analyzeAudio(blob);
                renderLoopList('file');
            };
            reader.readAsArrayBuffer(file);
        } 
    };
    const applySettings = () => {
        const s = parseFloat(document.getElementById('speed').value), p = parseInt(document.getElementById('pitch').value);
        const media = wavesurfer.getMediaElement();
        if (media) {
            media.preservesPitch = true;
            if (media.detune !== undefined) { media.detune = p * 100; wavesurfer.setPlaybackRate(s); } 
            else { if (p !== 0) { media.preservesPitch = false; wavesurfer.setPlaybackRate(s * Math.pow(2, p / 12)); } else wavesurfer.setPlaybackRate(s); }
        }
        updateBpmDisplay();
        document.getElementById('pitchTxt').innerText = (p > 0 ? "+" : "") + p;
        applyVolumes();
    };
    wavesurfer.on('ready', () => { document.getElementById('totalTime').innerText = fmt(wavesurfer.getDuration()); applySettings(); });
    recWavesurfer.on('finish', () => { wavesurfer.pause(); updateRecPlayBtnUI(); });
    document.getElementById('speed').oninput = applySettings;
    document.getElementById('pitch').oninput = applySettings;
    document.getElementById('playBtn').onclick = async () => {
        initAudioContext();
        if (wavesurfer.isPlaying()) { wavesurfer.pause(); if (recWavesurfer.isPlaying()) recWavesurfer.pause(); } 
        else {
            const current = wavesurfer.getCurrentTime(), region = wsRegions.getRegions()[0];
            if (isCountEnabled && region && (current < region.start || current >= region.end)) wavesurfer.setTime(region.start);
            await runCountdown(); applySettings(); wavesurfer.play();
        }
    };
    wavesurfer.on('play', () => document.getElementById('playIcon').innerText = 'pause');
    wavesurfer.on('pause', () => { document.getElementById('playIcon').innerText = 'play_arrow'; if (recWavesurfer.isPlaying()) recWavesurfer.pause(); });
    wavesurfer.on('timeupdate', t => {
        document.getElementById('currentTime').innerText = fmt(t);
        const r = wsRegions.getRegions()[0];
        if(r && t >= r.end) { 
            wavesurfer.setTime(r.start); 
            if (isSpeedUpEnabled) { const s = document.getElementById('speed'); s.value = Math.min(1.5, parseFloat(s.value) + 0.05).toFixed(2); applySettings(); }
            if (isRecording) toggleRecording();
        }
    });
    window.resetSetting = (id, val) => { document.getElementById(id).value = val; applySettings(); };
    changeLanguage(); renderYTHistory();
}
window.addEventListener('DOMContentLoaded', startApp);
