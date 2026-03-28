// オリジナルのロジックをすべて維持
const translations = { ja: { ... }, en: { ... } };

let wavesurfer, wsRegions, recWavesurfer;
// ... (元ファイルの全スクリプトをここに移植)

function startApp() {
    // プレイヤーの初期化設定など
    wavesurfer = WaveSurfer.create({ ... });
    // ...
}

window.addEventListener('DOMContentLoaded', startApp);
