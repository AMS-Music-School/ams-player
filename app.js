// ==================== YouTube検索用APIキー ====================
const YOUTUBE_API_KEY = "AIzaSyDVxlW-Unh4j4vRofeByf3el9Mh_16BoCg"; 
// ===============================================================

let deferredPrompt;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) installBtn.style.display = 'flex';
});

function updateInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    const installText = document.getElementById('installAppText');
    const installIcon = document.getElementById('installAppIcon');
    if (!installBtn || !installText || !installIcon) return;

    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];

    if (isMobile) {
        installText.innerText = t.installMobile || "ホーム画面に追加";
        installIcon.innerText = 'install_mobile';
    } else {
        installText.innerText = t.installDesktop || "デスクトップに追加";
        installIcon.innerText = 'install_desktop';
    }

    if (isIOS && !isStandalone) {
        installBtn.style.display = 'flex';
    }
}

function checkForUpdates() {
    const lang = document.getElementById('langSelect').value || 'ja';
    const msg = lang === 'ja' 
        ? "最新バージョンを確認しています...\nページを再読み込みします。" 
        : "Checking for updates...\nReloading page.";
    alert(msg);
    window.location.href = window.location.pathname + '?v=' + new Date().getTime();
}

function setThemeColor(color) {
    document.documentElement.style.setProperty('--primary-color', color);
    localStorage.setItem('ams_theme_color', color);
    
    document.querySelectorAll('.color-swatch').forEach(el => {
        if(el.getAttribute('data-color') === color) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });

    if (wavesurfer) {
        wavesurfer.setOptions({ progressColor: color });
    }
    if (wsRegions) {
        const rgba = getRegionColor(color);
        wsRegions.enableDragSelection({ color: rgba });
        wsRegions.getRegions().forEach(r => {
            r.setOptions({ color: rgba });
        });
    }
}

function getRegionColor(hex) {
    let c = hex.substring(1).split('');
    if(c.length === 3){ c= [c[0], c[0], c[1], c[1], c[2], c[2]]; }
    c= '0x'+c.join('');
    return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+',0.2)';
}

const savedThemeColor = localStorage.getItem('ams_theme_color') || '#d4a373';
document.documentElement.style.setProperty('--primary-color', savedThemeColor);

const firebaseConfig = {
    apiKey: "AIzaSyDI4ReBg15LAaQbd-4slccBHOS9R69sLNU",
    authDomain: "ams-player-e04bf.firebaseapp.com",
    projectId: "ams-player-e04bf",
    storageBucket: "ams-player-e04bf.firebasestorage.app",
    messagingSenderId: "102274983236",
    appId: "1:102274983236:web:f4334348391dde42dd6311",
    measurementId: "G-GYHLQKN6SS"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let isSubscribed = false;

// ==================== サーバーサイド購読確認（セキュリティ強化）====================
// isSubscribed 変数はコンソールから書き換え可能なため、
// プレミアム機能の実行前に必ずFirestoreを再確認する
let _subCache = null;
let _subCacheTime = 0;
const SUB_CACHE_MS = 30000; // 30秒キャッシュ（Firestoreアクセス頻度を抑制）

async function requireSubscription() {
    const user = auth.currentUser;
    if (!user) { openSubOverlay(); return false; }
    const now = Date.now();
    // キャッシュが有効な場合は再利用
    if (_subCache !== null && (now - _subCacheTime) < SUB_CACHE_MS) {
        if (!_subCache) openSubOverlay();
        return _subCache;
    }
    // Firestoreから最新のサブスク状態を取得
    try {
        const status = await checkSubscriptionStatus(user);
        _subCache = status.active;
        _subCacheTime = now;
        isSubscribed = status.active; // ローカル変数も同期
        if (!_subCache) openSubOverlay();
        return _subCache;
    } catch (e) {
        console.warn('Subscription check failed, using cached value:', e);
        if (!isSubscribed) openSubOverlay();
        return isSubscribed;
    }
}

function invalidateSubCache() { _subCache = null; _subCacheTime = 0; }
// =============================================================================

// ==================== TrialUsers コレクション管理 ====================
// トライアル開始時にTrialUsersへ記録
async function recordTrialStart(uEmail, uid, now) {
    try {
        const trialEndMs = now + (3 * 24 * 60 * 60 * 1000);
        await db.collection('TrialUsers').doc(uEmail).set({
            email: uEmail,
            uid: uid,
            trialStartMs: now,
            trialEndMs: trialEndMs,
            status: 'active',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('TrialUsers: trial started for', uEmail);
    } catch (e) {
        console.error('TrialUsers write error:', e);
    }
}

// トライアル・サブスク状態を更新（'active' | 'expired' | 'converted'）
async function updateTrialStatus(uEmail, status) {
    try {
        await db.collection('TrialUsers').doc(uEmail).update({
            status: status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('TrialUsers: status updated to', status, 'for', uEmail);
    } catch (e) {
        // ドキュメントが存在しない場合（トライアルなしユーザー）は無視
    }
}

// ログイン時にトライアル期限切れを自動検出・更新
async function checkAndUpdateTrialExpiry(uEmail, trialStartMs) {
    if (!trialStartMs) return;
    const now = Date.now();
    const trialEndMs = trialStartMs + (3 * 24 * 60 * 60 * 1000);
    if (now > trialEndMs) {
        await updateTrialStatus(uEmail, 'expired');
    }
}
// =====================================================================

let lastTime = 0;
let isRegistering = false; 

async function syncToCloud() {
    const user = auth.currentUser;
    if (!user || !user.email) return;
    const uEmail = user.email.toLowerCase().trim();
    try {
        const ytHistory = JSON.parse(localStorage.getItem('ams_yt_history') || "[]");
        const ams_loops = JSON.parse(localStorage.getItem('ams_loops') || "{}");
        const ams_yt_loops = JSON.parse(localStorage.getItem('ams_yt_loops') || "{}");
        await db.collection('Users').doc(uEmail).set({
            uid: user.uid,
            email: uEmail,
            ytHistory: ytHistory,
            ams_loops: ams_loops,
            ams_yt_loops: ams_yt_loops,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) { console.error("Cloud sync error:", e); }
}

async function syncFromCloud(user) {
    if (!user || !user.email) return;
    const uEmail = user.email.toLowerCase().trim();
    try {
        const doc = await db.collection('Users').doc(uEmail).get();
        if (doc.exists) {
            const data = doc.data();
            if (data.ytHistory) localStorage.setItem('ams_yt_history', JSON.stringify(data.ytHistory));
            if (data.ams_loops) localStorage.setItem('ams_loops', JSON.stringify(data.ams_loops));
            if (data.ams_yt_loops) localStorage.setItem('ams_yt_loops', JSON.stringify(data.ams_yt_loops));
        }
    } catch (e) { console.error("Cloud load error:", e); }
}

function getMsg(key) {
    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    return t[key] || translations['ja'][key] || "";
}

function openAuthOverlay() { document.getElementById('auth-overlay').style.display = 'flex'; }
function closeAuthOverlay() { document.getElementById('auth-overlay').style.display = 'none'; }
function closeSubOverlay() { document.getElementById('subscription-overlay').style.display = 'none'; }
function openAuthOverlayFromSub() { closeSubOverlay(); openAuthOverlay(); }
function togglePolicy(type, show) { const id = type === 'privacy' ? 'privacyPolicyModal' : 'legalNoticeModal'; document.getElementById(id).style.display = show ? 'block' : 'none'; if (show) toggleMenu(false); }

async function checkSubscriptionStatus(user) { 
    if (!user || !user.email) return { active: false, isTrial: false }; 
    const uEmail = user.email.toLowerCase().trim();
    try { 
        const schoolDoc = await db.collection('SchoolMember').doc(uEmail).get(); 
        if (schoolDoc.exists) { 
            const data = schoolDoc.data(); 
            if (data.isSubscribed === true || data.isStudent === true) return { active: true, isTrial: false }; 
        } 
        const userDoc = await db.collection('Users').doc(uEmail).get(); 
        if (userDoc.exists) { 
            const userData = userDoc.data(); 
            if (userData.isSubscribed === true) { 
                if (userData.expirationDate) { 
                    const now = new Date(); 
                    const expiration = userData.expirationDate.toDate(); 
                    if (now < expiration) return { active: true, isTrial: false }; 
                } else {
                    return { active: true, isTrial: false }; 
                }
            }
            if (userData.trialStartMs) {
                const now = Date.now();
                const trialEnd = userData.trialStartMs + (3 * 24 * 60 * 60 * 1000);
                if (now < trialEnd) {
                    return { active: true, isTrial: true, trialEndMs: trialEnd };
                }
            }
        } 
        return { active: false, isTrial: false }; 
    } catch (e) { return { active: false, isTrial: false }; } 
}

function openSubOverlay() {
    const user = auth.currentUser;
    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    
    const titleEl = document.getElementById('subTitle');
    const descEl = document.getElementById('subDesc');
    const startBtn = document.getElementById('subStartBtn');
    const regBtn = document.getElementById('subRegBtn');
    const logoutBtn = document.getElementById('subLogoutBtn');
    
    if (!user) {
        titleEl.innerText = t.subGuestTitle;
        descEl.innerHTML = t.subGuestDesc;
        regBtn.style.display = 'block';
        regBtn.innerText = t.subGuestRegBtn;
        startBtn.style.display = 'none';
        logoutBtn.style.display = 'none';
    } else {
        titleEl.innerText = t.subExpiredTitle;
        descEl.innerHTML = t.subExpiredDesc;
        regBtn.style.display = 'none';
        startBtn.style.display = 'block';
        startBtn.innerText = t.subStart;
        logoutBtn.style.display = 'block';
        logoutBtn.innerText = t.subLogout;
    }
    document.getElementById('subscription-overlay').style.display = 'flex';
}

function showWelcomeTrialPopup() {
    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    document.getElementById('trialWelcomeTitle').innerText = t.trialWelcomeTitle;
    document.getElementById('trialWelcomeDesc').innerText = t.trialWelcomeDesc;
    document.getElementById('trialStartBtn').innerText = t.trialStartBtn;
    document.getElementById('welcome-trial-overlay').style.display = 'flex';
}

function loginWithGoogle() { initAudioContext(); const provider = new firebase.auth.GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' }); auth.signInWithPopup(provider).then(() => closeAuthOverlay()).catch(e => alert(getMsg('msgLoginErr') + e.message)); }

function loginWithEmail() { 
    const email = document.getElementById('loginEmail').value.trim(); 
    const password = document.getElementById('loginPassword').value; 
    if(!email || !password) return alert(getMsg('msgEmptyAuth')); 
    initAudioContext(); 
    
    const btn = document.getElementById('emailLoginBtnTxt');
    btn.disabled = true;
    btn.innerText = "処理中...";
    
    auth.signInWithEmailAndPassword(email, password).then((userCredential) => { 
        if (!userCredential.user.emailVerified) {
            userCredential.user.sendEmailVerification().catch(()=>{});
            auth.signOut().then(() => {
                alert(getMsg('msgUnverified'));
                btn.disabled = false;
                btn.innerText = getMsg('authEmail');
            });
        } else {
            closeAuthOverlay(); 
            btn.disabled = false;
            btn.innerText = getMsg('authEmail');
        }
    }).catch((error) => { 
        if (error.code.includes('user-not-found') || error.code.includes('invalid-credential') || error.code.includes('wrong-password')) { 
            if(confirm(getMsg('msgRegConfirm'))) {
                isRegistering = true;
                auth.createUserWithEmailAndPassword(email, password).then((userCredential) => { 
                    userCredential.user.sendEmailVerification().then(() => {
                        auth.signOut().then(() => {
                            isRegistering = false;
                            alert(getMsg('msgVerifySent'));
                            location.reload(); 
                        });
                    });
                }).catch(e => {
                    isRegistering = false;
                    alert(getMsg('msgLoginErr') + e.message);
                    btn.disabled = false;
                    btn.innerText = getMsg('authEmail');
                }); 
            } else {
                btn.disabled = false;
                btn.innerText = getMsg('authEmail');
            }
        } else {
            alert(getMsg('msgLoginErr') + error.message); 
            btn.disabled = false;
            btn.innerText = getMsg('authEmail');
        }
    }); 
}

function forgotPassword() {
    const email = document.getElementById('loginEmail').value;
    if (!email) return alert(getMsg('msgEnterEmailPwReset'));
    auth.sendPasswordResetEmail(email).then(() => {
        alert(getMsg('msgMailSent'));
    }).catch((error) => {
        alert(getMsg('msgLoginErr') + error.message);
    });
}

function logout() { auth.signOut().then(() => location.reload()); }

function resetPassword() {
    const user = auth.currentUser;
    if (!user || !user.email) return;
    if (confirm(getMsg('msgPwReset'))) {
        auth.sendPasswordResetEmail(user.email).then(() => {
            alert(getMsg('msgMailSent'));
        }).catch((error) => {
            alert(getMsg('msgLoginErr') + error.message);
        });
    }
}

function redirectToCheckout() { 
    const user = auth.currentUser; 
    if (user) { 
        const uEmail = user.email.toLowerCase().trim();
        if (confirm(getMsg('msgSubConfirm'))) { 
            const baseUrl = "https://square.link/u/B13lqKnj"; 
            const checkoutUrl = `${baseUrl}?checkout_user_email=${encodeURIComponent(uEmail)}`; 
            window.location.href = checkoutUrl; 
        } 
    } else { 
        alert(getMsg('msgLoginReq')); 
        closeSubOverlay(); 
        openAuthOverlay(); 
    } 
}

function manageSubscription() { alert(getMsg('msgManageSub')); }

function openAccountModal() { const user = auth.currentUser; if (!user) { alert(getMsg('msgLoginReq')); toggleMenu(false); openAuthOverlay(); return; } updateAccountModalUI(user); document.getElementById('accountModal').style.display = 'block'; toggleMenu(false); }
function closeAccountModal() { document.getElementById('accountModal').style.display = 'none'; }

async function updateAccountModalUI(user) { 
    if (!user) return; 
    document.getElementById('accountDisplayName').innerText = user.displayName || user.email?.split('@')[0] || "No Name"; 
    document.getElementById('accountEmail').innerText = user.email || "No Email"; 
    document.getElementById('accountUid').innerText = user.uid; 
    
    const subStatus = await checkSubscriptionStatus(user); 
    const lang = document.getElementById('langSelect').value || 'ja'; 
    const t = translations[lang] || translations['ja']; 
    
    const planEl = document.getElementById('accountPlan');
    if (subStatus.active) {
        if (subStatus.isTrial) {
            const daysLeft = Math.ceil((subStatus.trialEndMs - Date.now()) / (1000 * 60 * 60 * 24));
            planEl.innerHTML = `<span style="color:var(--primary-color); font-weight:bold;">${t.planTrial.replace('{days}', daysLeft)}</span>`;
            document.getElementById('modalSubStartBtn').style.display = 'block';
            document.getElementById('modalSubManageBtn').style.display = 'none';
        } else {
            planEl.innerHTML = '<span style="color:var(--primary-color); font-weight:bold;">PREMIUM</span>';
            document.getElementById('modalSubStartBtn').style.display = 'none';
            document.getElementById('modalSubManageBtn').style.display = 'flex';
        }
    } else {
        planEl.innerHTML = t.planExpired;
        document.getElementById('modalSubStartBtn').style.display = 'block';
        document.getElementById('modalSubManageBtn').style.display = 'none';
    }
    
    document.getElementById('deleteAccText').innerText = t.deleteAcc; 
    document.getElementById('accNameLabel').innerText = t.accNameLabel; 
    document.getElementById('accEmailLabel').innerText = t.accEmailLabel; 
    document.getElementById('accUidLabel').innerText = 'UID'; 
    document.getElementById('accPlanLabel').innerText = t.accPlanLabel; 
    document.getElementById('accountModalTitle').innerText = t.accInfo; 
    document.getElementById('accountCloseBtn').innerText = t.close; 
    document.getElementById('accountMenuItem').innerText = t.accInfo; 
    document.getElementById('resetPwText').innerText = t.resetPw; 
    document.getElementById('modalSubStartBtn').innerText = t.modalSubStartText;
    document.getElementById('manageSubText').innerText = t.manageSubText;
    document.getElementById('updateBtnText').innerText = lang === 'ja' ? 'アップデートを確認' : 'Check for Updates';
}

async function deleteUserAccount() { const user = auth.currentUser; if (!user || !user.email) return alert(getMsg('msgLoginReq')); const uEmail = user.email.toLowerCase().trim(); if (!confirm(getMsg('msgDelAcc'))) return; try { await db.collection('Users').doc(uEmail).delete(); await user.delete(); alert(getMsg('msgDelAccSuccess')); location.reload(); } catch (error) { alert(getMsg('msgLoginErr') + error.message); } }

auth.onAuthStateChanged(async user => {
    if (isRegistering) return;
    invalidateSubCache(); // ログイン状態変化時はキャッシュをリセット
    
    if (user && user.providerData.some(p => p.providerId === 'password') && !user.emailVerified) { 
        return; 
    }

    const userInfo = document.getElementById('userInfoDisplay'), userNameSpan = document.getElementById('userName'), authSection = document.getElementById('auth-section'), authOverlay = document.getElementById('auth-overlay'), subOverlay = document.getElementById('subscription-overlay');
    
    if (user && user.email) {
        const uEmail = user.email.toLowerCase().trim();
        authOverlay.style.display = 'none'; authSection.style.display = 'none'; userInfo.style.display = 'flex';
        userNameSpan.innerText = user.displayName || user.email.split('@')[0];
        
        try { 
            const userDocRef = db.collection('Users').doc(uEmail);
            const userDoc = await userDocRef.get();
            
            let isAlreadyPremium = false;
            try {
                const schoolDoc = await db.collection('SchoolMember').doc(uEmail).get();
                if (schoolDoc.exists && (schoolDoc.data().isSubscribed === true || schoolDoc.data().isStudent === true)) {
                    isAlreadyPremium = true;
                }
            } catch(e) {}
            
            if (userDoc.exists && userDoc.data().isSubscribed === true) {
                const data = userDoc.data();
                if (data.expirationDate) {
                    if (new Date() < data.expirationDate.toDate()) isAlreadyPremium = true;
                } else {
                    isAlreadyPremium = true;
                }
            }

            if (!isAlreadyPremium && (!userDoc.exists || !userDoc.data().trialStartMs)) {
                // 新規トライアル開始
                const now = Date.now();
                await userDocRef.set({ uid: user.uid, email: uEmail, trialStartMs: now }, { merge: true });
                await recordTrialStart(uEmail, user.uid, now); // TrialUsersへ記録
                showWelcomeTrialPopup();
            } else {
                await userDocRef.set({ uid: user.uid, email: uEmail }, { merge: true });
                // 既存トライアルユーザーの期限切れチェック
                if (!isAlreadyPremium && userDoc.exists && userDoc.data().trialStartMs) {
                    checkAndUpdateTrialExpiry(uEmail, userDoc.data().trialStartMs);
                }
            }
        } catch (e) {}

        db.collection('Users').doc(uEmail).onSnapshot(async () => {
            const subStatus = await checkSubscriptionStatus(user);
            isSubscribed = subStatus.active;
            if (isSubscribed) {
                subOverlay.style.display = 'none';
                updateTrialStatus(uEmail, 'converted'); // 有料転換を記録
            }
            updateAccountModalUI(user);
        });
        db.collection('SchoolMember').doc(uEmail).onSnapshot(async () => {
            const subStatus = await checkSubscriptionStatus(user);
            isSubscribed = subStatus.active;
            if (isSubscribed) {
                subOverlay.style.display = 'none';
                updateTrialStatus(uEmail, 'converted'); // 有料転換を記録（SchoolMember経由）
            }
            updateAccountModalUI(user);
        });

        await syncFromCloud(user);
        if (currentMode === 'file') renderLoopList('file'); else renderLoopList('yt');
        renderYTHistory();
    } else { 
        userInfo.style.display = 'none'; authSection.style.display = 'block'; subOverlay.style.display = 'none'; isSubscribed = false; 
    }
});

const translations = {
    ja: { 
        langTitle: "言語設定", helpTitle: "ヘルプ & ガイド", themeTitle: "テーマカラー", guideFile: "Audio Fileモード ガイド", guideYT: "YouTubeモード ガイド", close: "閉じる", fit: "全体表示", clear: "選択解除", ready: "準備完了", analyzing: "解析中...", setStart: "START", setEnd: "END", loopOff: "LOOP OFF", loopOn: "LOOP ON", fileSelect: "ファイルを選択", saveLoop: "ループ保存", speedUpLabel: "自動BPMアップ", recPlay: "録音再生", recStop: "再生停止", privacyMenu: "Privacy Policy", legalMenu: "特定商取引法に基づく表記", authDesc: "アカウントでログイン", googleBtn: "Googleでログイン", authDiv: "または", authEmail: "ログイン / 新規登録", ytLoad: "LOAD", recDel: "削除", ytPlaceholder: "YouTubeのURL、または検索キーワード...",
        accInfo: "アカウント情報", deleteAcc: "アカウント削除", accNameLabel: "アカウント名", accEmailLabel: "メールアドレス", accPlanLabel: "プラン", resetPw: "パスワードを変更する",
        authNote: "※新規登録時は確認メールが送信されます。メール内のリンクを開いて登録を完了してください。",
        msgLoginReq: "先にログインしてください。", msgEmptyAuth: "メールアドレスとパスワードを入力してください", msgRegConfirm: "アカウントが見つかりません。新規登録として、入力されたアドレス宛に【確認メール】を送信します。よろしいですか？\n\n※受信したメール内のURLをクリックするまで登録は完了しません。", msgLoginErr: "エラー: ", msgMailSent: "パスワード再設定メールを送信しました。メールボックスをご確認ください。", msgDelHist: "履歴を削除しますか？", msgDelRec: "録音を削除しますか？", msgDelAcc: "アカウントを完全に削除します。すべての保存データが消去され、元に戻せません。\n\n⚠️【重要】アカウントを削除してもサブスクリプション（支払い）は自動で解約されません！必ず先にSquareからの決済メールより解約手続きを行ってください。\n\n本当に削除しますか？", msgDelAccSuccess: "アカウントを削除しました。", msgPwReset: "パスワード再設定の案内メールを送信しますか？", msgRangeReq: "範囲を指定してください", msgRangeInv: "範囲が不正です", msgSubConfirm: "⚠️【超重要】\nSquareの決済画面でも、必ず今ログインしている同じメールアドレスを使用して決済してください。\n（Apple Pay等を使用すると別のアドレスになる場合があります）\n\n支払手続きを進めますか？",
        forgotPw: "パスワードをお忘れですか？", msgUnverified: "メールアドレスが確認されていません。登録時にお送りした確認メール内のリンクをクリックして認証を完了してください。（※念のため確認メールを再送信しました）", msgVerifySent: "新規登録の確認メールを送信しました。メール内のリンクをクリックして登録を完了し、再度ログインしてください。", msgEnterEmailPwReset: "パスワードをリセットするには、メールアドレスを入力してください。", modalSubStartText: "サブスクリプションを開始する", manageSubText: "サブスクリプションを管理・解約", msgManageSub: "サブスクリプションの解約や管理は、Squareからの「決済完了メール」に記載されている「サブスクリプションを管理する」リンクからお手続きいただけます。",
        privacyInner: `<h2 style="color:var(--primary-color); margin-top:0;">プライバシーポリシー</h2><p>Anderson Studios（以下「当スタジオ」）が運営する「AMS Music Studio」は、提供するアプリケーション「AMS Practice Player」（以下「本アプリ」）における個人情報の取扱いについて、以下の通り定めます。</p><h3>1. 取得する情報</h3><p>本アプリでは、Google認証によるメールアドレス・氏名、およびサービス利用に必要な決済ステータス（Square経由）を取得します。</p><h3>2. 利用目的</h3><p>取得した情報は、アカウント認証、サブスクリプション管理、ユーザーサポート、および本アプリの機能提供のみに利用します。</p><h3>3. 第三者提供</h3><p>法令に基づく場合を除き、同意なく第三者に提供しません。本アプリはインフラとしてGoogle Firebase、決済としてSquareを利用します。</p><h3>4. お問い合わせ</h3><p>運営：Anderson Studios (AMS Music Studio)<br>連絡先：ams.guitar.school@gmail.com</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('privacy', false)">閉じる</button>`,
        legalInner: `<h2 style="color:var(--primary-color); margin-top:0;">特定商取引法に基づく表記</h2><h3>運営者名</h3><p>芦田幸一 (Anderson Studios / AMS Music Studio)</p><h3>連絡先</h3><p>ams.guitar.school@gmail.com</p><h3>販売価格</h3><p>購入手続きの際に画面に表示される金額（税込）</p><h3>代金の支払時期および方法</h3><p>Square決済（クレジットカード等）による即時決済。サブスクリプションは各更新日に課金されます。</p><h3>役務の提供時期</h3><p>決済完了後、直ちにご利用いただけます。</p><h3>解約・返金ポリシー</h3><p>・商品の性質上、決済完了後の返金・返品は原則としてお受けできません。<br>・サブスクリプションの解約はいつでも可能です。解約後も有効期限までは引き続きサービスをご利用いただけます。<br>・日割り計算による返金は行っておりません。</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('legal', false)">閉じる</button>`,
        guideFileContent: `<b>【Audio File Mode】フルガイド</b><span class="guide-sub">1. ファイル読み込み</span><ul><li>端末内の音楽ファイルを選択して解析。読み込み時にBPMが自動算出されます。</li></ul><span class="guide-sub">2. ABループ (範囲指定)</span><ul><li>波形をドラッグして範囲を選択。再生中、範囲の終端で自動的に始端へ戻ります。</li><li>「選択解除」でループを解除。「ループ保存」で楽曲ごとに複数の範囲を保存し、下のリストから瞬時に切り替え可能です。</li></ul><span class="guide-sub">3. BPMとPitchの変更</span><ul><li>BPMスライダーで速度を変更（0.5x〜1.5x）。</li><li>Pitchスライダーでキーを半音単位で変更（±6）。※Pitch変更にはサブスクが必要です。</li></ul><span class="guide-sub">4. 自動スピードアップ機能</span><ul><li>「⚡(ボルト)」ボタンをONにし「自動BPMアップ」を選択。ループを指定回数繰り返すごとに、自動でBPMが+0.05ずつ上がります（元のBPMまで）。</li></ul><span class="guide-sub">5. セルフ録音チェック</span><ul><li>「mic」ボタンで、再生しながら自分の音を録音。</li><li>録音データは波形の下に表示され、メイン音源と録音の音量を個別に調整できます。</li><li>「S(ソロ)」ボタンをONにすると、録音した音だけを聴くことができます。</li><li class="guide-note">※正確な録音と同期には、PCとオーディオインターフェースの利用を推奨します。</li><li class="guide-note">※モバイル端末（スマホ・タブレット）ではブラウザの仕様により、初期動作や録音動作が不安定になる場合があります。</li></ul><span class="guide-sub">6. 動作リフレッシュ機能</span><ul><li>モバイル端末などで音声の再生や波形の動作が不安定になった場合、波形上部の「FIT」ボタン右側にある「更新（リフレッシュ）ボタン」を押してください。</li><li>読み込んでいるファイルやループ設定を維持したまま、オーディオエンジンを安全に再起動して動作を安定させます。</li></ul><span class="guide-sub">【よくある質問 (FAQ)】</span><ul><li><b>メールアドレスの変更について:</b><br>メールアドレスを変更したい場合は、現在のサブスクリプションを一度解約し、有効期限が切れた後に新しいメールアドレスで再度新規登録（再決済）を行ってください。</li></ul>`,
        guideYTContent: `<b>【YouTube Mode】フルガイド</b><span class="guide-sub">1. 動画読み込み・検索</span><ul><li>YouTubeのURLを貼り付けて「LOAD」をタップ。</li><li>タイトルやアーティスト名を入力して検索することも可能です。（※コード内にAPIキーの設定が必要です。未設定時は別タブで検索画面が開きます）</li><li>読み込んだ動画は「RECENT HISTORY」に保存され、履歴から素早く再読み込みできます。</li></ul><span class="guide-sub">2. ABループ設定</span><ul><li>「START」と「END」ボタンで現在の再生位置をループ範囲に設定。</li><li>「-1 / +1」ボタンで、開始・終了位置を1秒単位で微調整できます。</li><li>「LOOP ON/OFF」ボタンでループの有効/無効を切り替えます。</li></ul><span class="guide-sub">3. ループの保存</span><ul><li>「SAVE」ボタンで設定したループ範囲を保存。</li><li>保存されたループは動画ごとにリスト化され、数字アイコンをタップするだけで瞬時に呼び出せます。</li></ul><span class="guide-sub">【よくある質問 (FAQ)】</span><ul><li><b>メールアドレスの変更について:</b><br>メールアドレスを変更したい場合は、現在のサブスクリプションを一度解約し、有効期限が切れた後に新しいメールアドレスで再度新規登録（再決済）を行ってください。</li></ul>`,
        installMobile: "ホーム画面に追加", installDesktop: "デスクトップに追加", iosInstallGuide: "Safari下部の共有ボタン [↑] から「ホーム画面に追加」を選択してください。", installNotAvailable: "このブラウザではインストール機能がサポートされていないか、すでにインストール済みです。",
        trialWelcomeTitle: "3日間無料トライアル開始！",
        trialWelcomeDesc: "ユーザー登録ありがとうございます！本日から3日間、すべてのプレミアム機能を無料でご利用いただけます。",
        trialStartBtn: "はじめる",
        subGuestTitle: "プレミアム機能 / 3日間無料体験",
        subGuestDesc: "ユーザー登録をすると、3日間すべてのプレミアム機能を無料でお試しいただけます！",
        subGuestRegBtn: "無料で登録して試す",
        subExpiredTitle: "トライアル期間終了",
        subExpiredDesc: "無料トライアルが終了しました。<br>引き続き全機能を利用するにはサブスクリプションの登録をお願いします。",
        planTrial: "3日間無料トライアル (残り: {days}日)",
        planExpired: "FREE (トライアル終了)",
        subStart: "サブスクリプションを開始する",
        subLogout: "別のカウントでログイン",
        historyTitle: "最近の履歴",
        historyClear: "すべてクリア",
        keyLabel: "キー", majorKey: "メジャー", minorKey: "マイナー"
    },
    en: { 
        langTitle: "Language Settings", helpTitle: "Help & Guide", themeTitle: "Theme Color", guideFile: "Audio File Mode Guide", guideYT: "YouTube Mode Guide", close: "Close", fit: "FIT", clear: "Clear Loop", ready: "READY", analyzing: "ANALYZING...", setStart: "START", setEnd: "END", loopOff: "LOOP OFF", loopOn: "LOOP ON", fileSelect: "Select Audio File", saveLoop: "Save Loop", speedUpLabel: "Auto BPM Up", recPlay: "Play Rec", recStop: "Stop Rec", privacyMenu: "Privacy Policy", legalMenu: "Commercial Transactions Act", authDesc: "Log in with your account", googleBtn: "Login with Google", authDiv: "OR", authEmail: "Login / Register", historyTitle: "RECENT HISTORY", historyClear: "Clear All", keyLabel: "Key", majorKey: "major", minorKey: "minor", ytLoad: "LOAD", recDel: "Delete", ytPlaceholder: "YouTube URL or Search Keyword...",
        accInfo: "Account Info", deleteAcc: "Delete Account", accNameLabel: "Display Name", accEmailLabel: "Email", accPlanLabel: "Plan", resetPw: "Reset Password",
        authNote: "*For new registrations, a verification email will be sent. Please open the link in the email to complete registration.",
        msgLoginReq: "Please login first.", msgEmptyAuth: "Please enter your email and password.", msgRegConfirm: "Account not found. A verification email will be sent to the entered address for new registration. Proceed?\n\n*Registration is NOT complete until you click the URL in the email.", msgLoginErr: "Error: ", msgMailSent: "Password reset email sent. Please check your inbox.", msgDelHist: "Clear history?", msgDelRec: "Delete recording?", msgDelAcc: "This will permanently delete your account and all saved data.\n\n⚠️ IMPORTANT: Deleting your account does NOT automatically cancel your subscription! Please cancel your billing via the Square receipt email first.\n\nAre you sure you want to delete?", msgDelAccSuccess: "Account successfully deleted.", msgPwReset: "Send password reset email?", msgRangeReq: "Please select a range", msgRangeInv: "Invalid range", msgSubConfirm: "⚠️ IMPORTANT\nPlease use the exact same email address on the Square payment page.\n(Using Apple Pay might change your address)\n\nProceed to checkout?",
        forgotPw: "Forgot Password?", msgUnverified: "Email address is not verified. Please click the link in the verification email to complete authentication. (A new verification email has been sent just in case)", msgVerifySent: "A verification email has been sent. Please click the link in the email to complete registration and log in again.", msgEnterEmailPwReset: "Please enter your email address to reset your password.", modalSubStartText: "Start Subscription", manageSubText: "Manage / Cancel Subscription", msgManageSub: "To manage or cancel your subscription, please use the 'Manage Subscription' link found in your Square payment receipt email.",
        privacyInner: `<h2 style="color:var(--primary-color); margin-top:0;">Privacy Policy</h2><p>Anderson Studios ("We/Us") operating as "AMS Music Studio" establishes this Privacy Policy regarding the handling of personal information in the "AMS Practice Player" ("App").</p><h3>1. Collected Information</h3><p>The App collects email addresses and names via Google Authentication, and payment statuses via Square for subscription management.</p><h3>2. Purpose of Use</h3><p>Collected information is used solely for authentication, subscription management, user support, and delivering App features.</p><h3>3. Third-Party Sharing</h3><p>We do not share information with third parties without consent, except as required by law. The App utilizes Google Firebase and Square.</p><h3>4. Contact</h3><p>Operator: Anderson Studios (AMS Music Studio)<br>Contact: ams.guitar.school@gmail.com</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('privacy', false)">Close</button>`,
        legalInner: `<h2 style="color:var(--primary-color); margin-top:0;">Legal Notice</h2><h3>Operator</h3><p>Koichi Ashida (Anderson Studios / AMS Music Studio)</p><h3>Contact</h3><p>ams.guitar.school@gmail.com</p><h3>Pricing</h3><p>Displayed during the purchase process (Tax included).</p><h3>Payment</h3><p>Immediate payment via Square (Credit Card, etc.). Subscriptions are billed on each renewal date.</p><h3>Delivery</h3><p>Service is available immediately after payment completion.</p><h3>Refund Policy</h3><p>・Due to the nature of digital services, refunds are generally not accepted after payment.<br>・Subscriptions can be canceled at any time. The service remains active until the end of the current billing period.<br>・No pro-rated refunds are provided.</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('legal', false)">Close</button>`,
        guideFileContent: `<b>【Audio File Mode】Full Guide</b><span class="guide-sub">1. Load Audio</span><ul><li>Select a file to analyze BPM automatically.</li></ul><span class="guide-sub">2. AB Loop</span><ul><li>Drag waveform to select range. Use "Save Loop" to store segments.</li></ul><span class="guide-sub">3. BPM & Pitch</span><ul><li>Adjust speed (0.5x-1.5x) and Pitch (±6). *Pitch requires subscription.</li></ul><span class="guide-sub">4. Auto Speed Up</span><ul><li>Enable "Bolt" and select "Auto BPM Up". The BPM will automatically increase by +0.05 per interval.</li></ul><span class="guide-sub">5. Recording</span><ul><li>Record while playing. Adjust Main/Rec volume or use "Solo(S)" to hear only the recording.</li><li class="guide-note">*Using a PC and Audio Interface is highly recommended for stable sync.</li><li class="guide-note">*Mobile devices may experience unstable initial operation or recording due to browser limitations.</li></ul><span class="guide-sub">6. Refresh Player</span><ul><li>If audio playback or waveform interaction becomes unstable (especially on mobile devices), tap the "Refresh" button located to the right of the "FIT" button.</li><li>This safely restarts the audio engine while keeping your loaded file and loop settings intact.</li></ul><span class="guide-sub">FAQ</span><ul><li><b>Changing Email Address:</b><br>If you wish to change your email address, please cancel your current subscription and register again (re-subscribe) with your new email address after the current subscription expires.</li></ul>`,
        guideYTContent: `<b>【YouTube Mode】Full Guide</b><span class="guide-sub">1. Load Video</span><ul><li>Paste URL or search keywords and tap LOAD. Recently viewed videos are saved in History.</li></ul><span class="guide-sub">2. AB Loop</span><ul><li>Use START/END to define range. Fine-tune with -1/+1 buttons.</li><li>Toggle LOOP ON/OFF to control repetition.</li></ul><span class="guide-sub">3. Save Loops</span><ul><li>Save multiple loop ranges per video and recall them instantly via the loop list.</li></ul><span class="guide-sub">FAQ</span><ul><li><b>Changing Email Address:</b><br>If you wish to change your email address, please cancel your current subscription and register again (re-subscribe) with your new email address after the current subscription expires.</li></ul>`,
        installMobile: "Add to Home Screen", installDesktop: "Install App", iosInstallGuide: "Tap the Share button [↑] in Safari and select 'Add to Home Screen'.", installNotAvailable: "Installation is not supported in this browser or already installed.",
        trialWelcomeTitle: "3-Day Free Trial Started!",
        trialWelcomeDesc: "Thank you for registering! You can use all premium features for free for the next 3 days.",
        trialStartBtn: "Start",
        subGuestTitle: "Premium / 3-Day Free Trial",
        subGuestDesc: "Register now to try all premium features for free for 3 days!",
        subGuestRegBtn: "Register & Try for Free",
        subExpiredTitle: "Trial Expired",
        subExpiredDesc: "Your free trial has ended.<br>Please subscribe to continue using all premium features.",
        planTrial: "3-Day Free Trial ({days} days left)",
        planExpired: "FREE (Trial Expired)",
        subStart: "Start Subscription",
        subLogout: "Login with another account"
    },
    zh: { 
        langTitle: "语言设置", helpTitle: "帮助与指南", themeTitle: "主题颜色", guideFile: "音频文件模式指南", guideYT: "YouTube模式指南", close: "关闭", fit: "适应视图", clear: "清除选择", ready: "准备就绪", analyzing: "分析中...", setStart: "起点", setEnd: "终点", loopOff: "循环 关", loopOn: "循环 开", fileSelect: "选择文件", saveLoop: "保存循环", speedUpLabel: "自动提速", recPlay: "播放录音", recStop: "停止播放", privacyMenu: "隐私政策", legalMenu: "特定商业交易法", authDesc: "使用您的帐户登录", googleBtn: "使用Google登录", authDiv: "或", authEmail: "登录 / 注册", historyTitle: "最近历史", historyClear: "全部清除", keyLabel: "调性", majorKey: "大调", minorKey: "小调", ytLoad: "加载", recDel: "删除", ytPlaceholder: "YouTube URL 或搜索关键字...",
        accInfo: "帐户信息", deleteAcc: "删除帐户", accNameLabel: "帐户名称", accEmailLabel: "电子邮件", accPlanLabel: "计划", resetPw: "重置密码",
        authNote: "※新注册时将发送验证邮件。请打开邮件中的链接以完成注册。",
        msgLoginReq: "请先登录。", msgEmptyAuth: "请输入您的电子邮件和密码。", msgRegConfirm: "找不到帐户。系统将向您输入的地址发送一封验证邮件以进行新注册。是否继续？\n\n*在点击收到的邮件中的URL之前，注册不会完成。", msgLoginErr: "错误: ", msgMailSent: "密码重置邮件已发送。请检查您的收件箱。", msgDelHist: "要清除历史记录吗？", msgDelRec: "要删除录音吗？", msgDelAcc: "这将永久删除您的帐户和所有保存的数据。\n\n⚠️ 重要提示：删除帐户不会自动取消您的订阅！请务必先通过Square的付款电子邮件取消订阅。\n\n您确定要删除吗？", msgDelAccSuccess: "帐户已成功删除。", msgPwReset: "发送密码重置电子邮件吗？", msgRangeReq: "请选择一个范围", msgRangeInv: "范围无效", msgSubConfirm: "⚠️ 重要提示\n请在Square付款页面上使用完全相同的电子邮件地址。\n\n继续结帐吗？",
        forgotPw: "忘记密码？", msgUnverified: "电子邮件地址未验证。请点击验证邮件中的链接以完成身份验证。（已重新发送验证邮件）", msgVerifySent: "已发送验证邮件。请点击邮件中的链接完成注册并重新登录。", msgEnterEmailPwReset: "请输入您的电子邮件地址以重置密码。", modalSubStartText: "开始订阅", manageSubText: "管理 / 取消订阅", msgManageSub: "要管理或取消您的订阅，请使用Square付款收据电子邮件中的“管理订阅”链接。",
        privacyInner: `<h2 style="color:var(--primary-color); margin-top:0;">隐私政策</h2><p>Anderson Studios（以下简称“本工作室”）运营的“AMS Music Studio”针对其提供的应用程序“AMS Practice Player”（以下简称“本应用”）中的个人信息处理，制定以下政策。</p><h3>1. 收集的信息</h3><p>本应用将通过Google身份验证获取您的电子邮件地址、姓名，以及提供服务所需的付款状态（通过Square）。</p><h3>2. 使用目的</h3><p>收集的信息仅用于帐户认证、订阅管理、用户支持以及提供本应用的功能。</p><h3>3. 向第三方提供</h3><p>除法律规定外，未经同意，我们不会向第三方提供您的信息。本应用使用Google Firebase作为基础设施，使用Square进行付款处理。</p><h3>4. 联系我们</h3><p>运营商：Anderson Studios (AMS Music Studio)<br>联系邮箱：ams.guitar.school@gmail.com</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('privacy', false)">关闭</button>`,
        legalInner: `<h2 style="color:var(--primary-color); margin-top:0;">特定商业交易法 / 法律声明</h2><h3>运营商名称</h3><p>芦田幸一 (Anderson Studios / AMS Music Studio)</p><h3>联系方式</h3><p>ams.guitar.school@gmail.com</p><h3>销售价格</h3><p>购买过程中屏幕上显示的金额（含税）</p><h3>付款时间及方式</h3><p>通过Square（信用卡等）即时付款。订阅将在每个续订日收费。</p><h3>服务提供时间</h3><p>付款完成后立即可用。</p><h3>取消与退款政策</h3><p>・由于数字产品的性质，付款完成后原则上不接受退款或退货。<br>・您可以随时取消订阅。取消后，您仍可在有效期内继续使用服务。<br>・我们不提供按比例退款。</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('legal', false)">关闭</button>`,
        guideFileContent: `<b>【音频文件模式】完整指南</b><span class="guide-sub">1. 加载文件</span><ul><li>选择设备中的音频文件进行解析。加载时将自动计算BPM。</li></ul><span class="guide-sub">2. AB循环（指定范围）</span><ul><li>拖动波形以选择范围。播放期间，到达范围末端时将自动返回起点。</li><li>使用“清除选择”取消循环。使用“保存循环”为每首歌曲保存多个范围，并从下方列表中立即切换。</li></ul><span class="guide-sub">3. 更改BPM和音调</span><ul><li>使用BPM滑块更改速度（0.5x〜1.5x）。</li><li>使用音调滑块以半音为单位更改音调（±6）。※更改音调需要订阅。</li></ul><span class="guide-sub">4. 自动加速功能</span><ul><li>打开“⚡（闪电）”按钮并选择“自动提速”。每当循环重复指定次数时，自动提速+0.05（最高回到原始BPM）。</li></ul><span class="guide-sub">5. 录音自我检查</span><ul><li>使用“mic”按钮在播放时录制自己的声音。</li><li>录音数据将显示在波形下方，您可以分别调整主音源和录音的音量。</li><li>打开“S（独奏）”按钮时，您只能听到录制的声音。</li><li class="guide-note">※为确保准确的录音和同步，建议使用PC和音频接口。</li><li class="guide-note">※在移动设备（智能手机/平板电脑）上，由于浏览器的限制，初始操作或录音操作可能会不稳定。</li></ul><span class="guide-sub">6. 刷新播放器</span><ul><li>如果音频播放或波形操作变得不稳定（尤其是在移动设备上），请点击“FIT”按钮右侧的“刷新”按钮。</li><li>这将在保留已加载文件和循环设置的同时，安全地重新启动音频引擎以稳定操作。</li></ul><span class="guide-sub">【常见问题 (FAQ)】</span><ul><li><b>关于更改电子邮件地址：</b><br>如果您想更改电子邮件地址，请先取消当前订阅，并在有效期结束后使用新电子邮件地址重新注册（重新付款）。</li></ul>`,
        guideYTContent: `<b>【YouTube模式】完整指南</b><span class="guide-sub">1. 加载视频</span><ul><li>粘贴YouTube的URL，或者输入关键字进行搜索，然后点击“LOAD”。</li><li>加载的视频将保存在“RECENT HISTORY”中，您可以从历史记录中快速重新加载。</li></ul><span class="guide-sub">2. AB循环设置</span><ul><li>使用“START”和“END”按钮将当前播放位置设置为循环范围。</li><li>使用“-1 / +1”按钮，可以微调起点和终点位置。</li><li>使用“LOOP ON/OFF”按钮切换循环。</li></ul><span class="guide-sub">3. 保存循环</span><ul><li>使用“SAVE”按钮保存设置的循环范围。</li><li>保存的循环将按视频列出，只需点击数字图标即可立即调用。</li></ul><span class="guide-sub">【常见问题 (FAQ)】</span><ul><li><b>关于更改电子邮件地址：</b><br>如果您想更改电子邮件地址，请先取消当前订阅，并在有效期结束后使用新电子邮件地址重新注册（重新付款）。</li></ul>`,
        installMobile: "添加到主屏幕", installDesktop: "安装到桌面", iosInstallGuide: "请点击Safari底部的分享按钮 [↑]，然后选择“添加到主屏幕”。", installNotAvailable: "此浏览器不支持安装功能，或已安装。",
        trialWelcomeTitle: "3天免费试用开始！",
        trialWelcomeDesc: "感谢您的注册！从今天起，您可以免费使用所有高级功能3天。",
        trialStartBtn: "开始",
        subGuestTitle: "高级功能 / 3天免费试用",
        subGuestDesc: "注册即可免费试用所有高级功能3天！",
        subGuestRegBtn: "免费注册试用",
        subExpiredTitle: "试用期结束",
        subExpiredDesc: "您的免费试用已结束。<br>请订阅以继续使用所有高级功能。",
        planTrial: "3天免费试用（剩余 {days} 天）",
        planExpired: "免费版 (试用结束)",
        subStart: "开始订阅",
        subLogout: "使用其他帐户登录"
    },
    ko: { 
        langTitle: "언어 설정", helpTitle: "도움말 및 가이드", themeTitle: "테마 색상", guideFile: "오디오 파일 모드 가이드", guideYT: "YouTube 모드 가이드", close: "닫기", fit: "전체 보기", clear: "선택 해제", ready: "준비 완료", analyzing: "분석 중...", setStart: "시작", setEnd: "종료", loopOff: "루프 끄기", loopOn: "루프 켜기", fileSelect: "파일 선택", saveLoop: "루프 저장", speedUpLabel: "자동 BPM 업", recPlay: "녹음 재생", recStop: "재생 정지", privacyMenu: "개인정보처리방침", legalMenu: "특정상거래법 표기", authDesc: "계정으로 로그인", googleBtn: "Google로 로그인", authDiv: "또는", authEmail: "로그인 / 회원가입", historyTitle: "최근 기록", historyClear: "모두 지우기", keyLabel: "조성", majorKey: "장조", minorKey: "단조", ytLoad: "불러오기", recDel: "삭제", ytPlaceholder: "YouTube URL 또는 검색 키워드...",
        accInfo: "계정 정보", deleteAcc: "계정 삭제", accNameLabel: "계정 이름", accEmailLabel: "이메일", accPlanLabel: "플랜", resetPw: "비밀번호 재설정",
        authNote: "※신규 가입 시 확인 이메일이 발송됩니다. 이메일의 링크를 열어 가입을 완료해 주세요.",
        msgLoginReq: "먼저 로그인해 주세요.", msgEmptyAuth: "이메일과 비밀번호를 입력해 주세요.", msgRegConfirm: "계정을 찾을 수 없습니다. 신규 가입을 위해 입력하신 주소로 확인 이메일이 발송됩니다. 계속하시겠습니까?\n\n※수신한 이메일의 URL을 클릭하기 전까지는 가입이 완료되지 않습니다.", msgLoginErr: "오류: ", msgMailSent: "비밀번호 재설정 이메일을 보냈습니다. 받은 편지함을 확인하세요.", msgDelHist: "기록을 삭제하시겠습니까?", msgDelRec: "녹음을 삭제하시겠습니까?", msgDelAcc: "계정과 모든 저장된 데이터가 영구적으로 삭제됩니다.\n\n⚠️ 중요: 계정을 삭제해도 구독(결제)은 자동으로 해지되지 않습니다! 반드시 먼저 Square 결제 이메일에서 해지 절차를 진행해 주세요.\n\n정말 삭제하시겠습니까?", msgDelAccSuccess: "계정이 성공적으로 삭제되었습니다.", msgPwReset: "비밀번호 재설정 이메일을 보내시겠습니까?", msgRangeReq: "범위를 지정해 주세요", msgRangeInv: "잘못된 범위입니다", msgSubConfirm: "⚠️ 중요\nSquare 결제 페이지에서도 완전히 동일한 이메일 주소를 사용해 주세요.\n\n결제를 진행하시겠습니까?",
        forgotPw: "비밀번호를 잊으셨나요?", msgUnverified: "이메일 주소가 확인되지 않았습니다. 인증 이메일의 링크를 클릭하여 인증을 완료해 주세요. (확인 이메일을 재발송했습니다)", msgVerifySent: "가입 확인 이메일을 발송했습니다. 이메일의 링크를 클릭하여 등록을 완료한 후 다시 로그인해 주세요.", msgEnterEmailPwReset: "비밀번호를 재설정하려면 이메일 주소를 입력해 주세요.", modalSubStartText: "구독 시작하기", manageSubText: "구독 관리 / 해지", msgManageSub: "구독을 관리하거나 해지하려면 Square 결제 영수증 이메일에 있는 '구독 관리' 링크를 이용해 주세요.",
        privacyInner: `<h2 style="color:var(--primary-color); margin-top:0;">개인정보처리방침</h2><p>Anderson Studios(이하 '당 스튜디오')가 운영하는 'AMS Music Studio'은 제공하는 애플리케이션 'AMS Practice Player'(이하 '본 앱')의 개인정보 처리에 대해 다음과 같이 정합니다.</p><h3>1. 수집하는 정보</h3><p>본 앱에서는 Google 인증을 통한 이메일 주소, 이름 및 서비스 이용에 필요한 결제 상태(Square 경유)를 수집합니다.</p><h3>2. 이용 목적</h3><p>수집한 정보는 계정 인증, 구독 관리, 사용자 지원 및 본 앱의 기능 제공 목적으로만 이용됩니다.</p><h3>3. 제3자 제공</h3><p>법령에 의한 경우를 제외하고, 동의 없이 제3자에게 제공하지 않습니다. 본 앱은 인프라로 Google Firebase를, 결제 시스템으로 Square 정합니다.</p><h3>4. 문의처</h3><p>운영: Anderson Studios (AMS Music Studio)<br>연락처: ams.guitar.school@gmail.com</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('privacy', false)">닫기</button>`,
        legalInner: `<h2 style="color:var(--primary-color); margin-top:0;">특정상거래법 표기 / 법적 고지</h2><h3>운영자명</h3><p>Koichi Ashida (Anderson Studios / AMS Music Studio)</p><h3>연락처</h3><p>ams.guitar.school@gmail.com</p><h3>판매 가격</h3><p>구매 절차 시 화면에 표시되는 금액 (세금 포함)</p><h3>대금 결제 시기 및 방법</h3><p>Square 결제(신용카드 등)를 통한 즉시 결제. 구독은 매 갱신일에 과금됩니다.</p><h3>서비스 제공 시기</h3><p>결제 완료 후 즉시 이용 가능합니다.</p><h3>해지 및 환불 정책</h3><p>・상품의 특성상, 결제 완료 후의 환불 및 반품은 원칙적으로 불가능합니다.<br>・구독 해지는 언제든지 가능합니다. 해지 후에도 유효기간까지는 계속해서 서비스를 이용하실 수 있습니다.<br>・일할 계산에 의한 환불은 진행하지 않습니다.</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('legal', false)">닫기</button>`,
        guideFileContent: `<b>【오디오 파일 모드】 전체 가이드</b><span class="guide-sub">1. 파일 불러오기</span><ul><li>기기 내의 음악 파일을 선택하여 분석합니다. 불러올 때 BPM이 자동으로 계산됩니다.</li></ul><span class="guide-sub">2. AB 루프 (범위 지정)</span><ul><li>파형을 드래그하여 범위를 선택합니다. 재생 중 범위의 끝에 도달하면 자동으로 시작점으로 돌아갑니다.</li><li>'선택 해제'로 루프를 해제합니다. '루프 저장'으로 곡마다 여러 범위를 저장하고, 아래 목록에서 즉시 전환할 수 있습니다.</li></ul><span class="guide-sub">3. BPM 및 피치 변경</span><ul><li>BPM 슬라이더로 속도를 변경합니다 (0.5x〜1.5x).</li><li>피치 슬라이더로 키를 반음 단위로 변경합니다 (±6). ※피치 변경에는 구독이 필요합니다.</li></ul><span class="guide-sub">4. 자동 스피드 업 기능</span><ul><li>'⚡(번개)' 버튼을 켜고 '자동 BPM 업'을 선택합니다. 지정한 횟수만큼 루프를 반복할 때마다 자동으로 BPM이 +0.05씩 올라갑니다 (원래 BPM까지).</li></ul><span class="guide-sub">5. 셀프 녹음 체크</span><ul><li>'mic 버튼으로 재생하면서 자신의 소리를 녹음합니다.</li><li>녹음 데이터는 파형 아래에 표시되며, 메인 음원과 녹음의 볼륨을 개별적으로 조절할 수 조절할 수 있습니다.</li><li>'S(솔로)' 버튼을 켜면 녹음한 소리만 들을 수 있습니다.</li><li class="guide-note">※정확한 녹음과 동기화를 위해 PC와 오디오 인터페이스 사용을 권장합니다.</li><li class="guide-note">※모바일 기기(스마트폰/태블릿)에서는 브라우저의 제한으로 인해 초기 동작이나 녹음 동작이 불안정할 수 있습니다.</li></ul><span class="guide-sub">6. 동작 새로고침(리프레시)</span><ul><li>모바일 기기 등에서 오디오 재생이나 파형 동작이 불안정해질 경우, 파형 상단의 'FIT' 버튼 오른쪽에 있는 '새로고침' 버튼을 눌러주세요.</li><li>불러온 파일과 루프 설정을 유지한 채 오디오 엔진을 안전하게 재시작하여 동작을 안정시킵니다.</li></ul><span class="guide-sub">【자주 묻는 질문 (FAQ)】</span><ul><li><b>이메일 주소 변경에 대하여:</b><br>이메일 주소를 변경하시려면 현재 구독을 먼저 해지하시고, 유효기간이 만료된 후 새로운 이메일 주소로 다시 신규 가입(재결제)해 주시기 바랍니다.</li></ul>`,
        guideYTContent: `<b>【YouTube 모드】 전체 가이드</b><span class="guide-sub">1. 동영상 불러오기</span><ul><li>YouTube의 URL을 붙여넣거나 키워드를 입력하고 'LOAD'를 탭합니다.</li><li>불러온 동영상은 'RECENT HISTORY'에 저장되어 기록에서 빠르게 다시 불러올 수 있습니다.</li></ul><span class="guide-sub">2. AB 루프 설정</span><ul><li>'START' 및 'END' 버튼으로 현재 재생 위치를 루프 범위로 설정합니다.</li><li>'-1 / +1' 버튼으로 미세 조정할 수 있습니다.</li><li>'LOOP ON/OFF' 버튼으로 루프 활성화/비활성화를 전환합니다.</li></ul><span class="guide-sub">3. 루프 저장</span><ul><li>'SAVE' 버튼으로 설정한 루프 범위를 저장합니다.</li><li>저장된 루프는 동영상별로 목록화되며, 숫자 아이콘을 탭하는 것만으로 즉시 불러올 수 있습니다.</li></ul><span class="guide-sub">【자주 묻는 질문 (FAQ)】</span><ul><li><b>이메일 주소 변경에 대하여:</b><br>이메일 주소를 변경하시려면 현재 구독을 먼저 해지하시고, 유효기간이 만료된 후 새로운 이메일 주소로 다시 신규 가입(재결제)해 주시기 바랍니다.</li></ul>`,
        installMobile: "홈 화면에 추가", installDesktop: "데스크톱에 추가", iosInstallGuide: "Safari 하단의 공유 버튼 [↑]을 탭하고 '홈 화면에 추가'를 선택하세요.", installNotAvailable: "이 브라우저에서는 설치가 지원되지 않거나 이미 설치되어 있습니다.",
        trialWelcomeTitle: "3일 무료 평가판 시작!",
        trialWelcomeDesc: "가입해 주셔서 감사합니다! 오늘부터 3일 동안 모든 프리미엄 기능을 무료로 이용하실 수 있습니다.",
        trialStartBtn: "시작하기",
        subGuestTitle: "프리미엄 / 3일 무료 체험",
        subGuestDesc: "회원가입 후 3일 동안 모든 프리미엄 기능을 무료로 체험해 보세요!",
        subGuestRegBtn: "무료로 가입하고 체험하기",
        subExpiredTitle: "평가판 종료",
        subExpiredDesc: "무료 평가판이 종료되었습니다.<br>모든 기능을 계속 사용하려면 구독해 주세요.",
        planTrial: "3일 무료 평가판 (남은 기간: {days}일)",
        planExpired: "FREE (평가판 종료)",
        subStart: "구독 시작하기",
        subLogout: "다른 계정으로 로그인"
    },
    es: { 
        langTitle: "Idioma", helpTitle: "Ayuda y Guía", themeTitle: "Color del Tema", guideFile: "Guía Modo Archivo", guideYT: "Guía Modo YouTube", close: "Cerrar", fit: "Ajustar", clear: "Borrar", ready: "LISTO", analyzing: "ANALIZANDO...", setStart: "INICIO", setEnd: "FIN", loopOff: "BUCLE OFF", loopOn: "BUCLE ON", fileSelect: "Elegir Archivo", saveLoop: "Guardar", speedUpLabel: "Auto BPM Up", recPlay: "Reproducir", recStop: "Detener", privacyMenu: "Privacidad", legalMenu: "Aviso Legal", authDesc: "Inicia sesión con tu cuenta", googleBtn: "Iniciar con Google", authDiv: "O", authEmail: "Iniciar / Registrarse", historyTitle: "Historial", historyClear: "Borrar Todo", keyLabel: "Tonalidad", majorKey: "mayor", minorKey: "menor", ytLoad: "CARGAR", recDel: "Eliminar", ytPlaceholder: "URL de YouTube o palabra clave de búsqueda...",
        accInfo: "Cuenta", deleteAcc: "Eliminar Cuenta", accNameLabel: "Nombre", accEmailLabel: "Correo", accPlanLabel: "Plan", resetPw: "Restablecer Contraseña",
        authNote: "*Para nuevos registros, se enviará un correo de verificación. Abra el enlace en el correo para completar el registro.",
        msgLoginReq: "Inicie sesión primero.", msgEmptyAuth: "Ingrese su correo y contraseña.", msgRegConfirm: "Cuenta no encontrada. Se enviará un correo de verificación a la dirección ingresada para un nuevo registro. ¿Continuar?\n\n*El registro NO se completará hasta que haga clic en la URL del correo.", msgLoginErr: "Error: ", msgMailSent: "Correo de restablecimiento enviado. Revise su bandeja.", msgDelHist: "¿Borrar historial?", msgDelRec: "¿Eliminar grabación?", msgDelAcc: "Esto eliminará permanentemente su cuenta y datos.\n\n⚠️ IMPORTANTE: ¡Eliminar su cuenta NO cancelará automáticamente su suscripción! Por favor, cancele su facturación a través del correo de recibo de Square primero.\n\n¿Está seguro de que desea eliminar?", msgDelAccSuccess: "Cuenta eliminada con éxito.", msgPwReset: "¿Enviar correo para restablecer contraseña?", msgRangeReq: "Seleccione un rango", msgRangeInv: "Rango inválido", msgSubConfirm: "⚠️ IMPORTANTE\nUse exactamente el mismo correo en la página de pago de Square.\n\n¿Proceder al pago?",
        forgotPw: "¿Olvidaste tu contraseña?", msgUnverified: "La dirección de correo no está verificada. Haga clic en el enlace del correo de verificación para completar la autenticación. (Se ha reenviado un correo de verificación)", msgVerifySent: "Se ha enviado un correo de verificación. Haga clic en el enlace del correo para completar el registro y vuelva a iniciar sesión.", msgEnterEmailPwReset: "Ingrese su dirección de correo electrónico para restablecer su contraseña.", modalSubStartText: "Suscribirse", manageSubText: "Administrar / Cancelar Suscripción", msgManageSub: "Para administrar o cancelar su suscripción, use el enlace 'Administrar suscripción' que se encuentra en el correo electrónico de recibo de pago de Square.",
        privacyInner: `<h2 style="color:var(--primary-color); margin-top:0;">Política de Privacidad</h2><p>"AMS Music Studio", operada por Anderson Studios (en adelante "el Estudio"), establece la siguiente política con respecto al manejo de información personal en la aplicación "AMS Practice Player" (en adelante "la Aplicación").</p><h3>1. Información Recopilada</h3><p>Esta aplicación recopila su dirección de correo electrónico y nombre a través de la autenticación de Google, y el estado de pago necesario para utilizar el servicio (a través de Square).</p><h3>2. Propósito de Uso</h3><p>La información recopilada se utilizará únicamente para la autenticación de la cuenta, gestión de suscripciones, soporte al usuario y para proporcionar las funciones de esta aplicación.</p><h3>3. Provisión a Terceros</h3><p>A menos que lo exija la ley, no proporcionaremos su información a terceros sin su consentimiento. Esta aplicación utiliza Google Firebase como infraestructura y Square para los pagos.</p><h3>4. Contacto</h3><p>Operador: Anderson Studios (AMS Music Studio)<br>Correo: ams.guitar.school@gmail.com</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('privacy', false)">Cerrar</button>`,
        legalInner: `<h2 style="color:var(--primary-color); margin-top:0;">Aviso Legal / Ley de Transacciones Comerciales</h2><h3>Nombre del Operador</h3><p>Koichi Ashida (Anderson Studios / AMS Music Studio)</p><h3>Contacto</h3><p>ams.guitar.school@gmail.com</p><h3>Precio de Venta</h3><p>El monto mostrado en pantalla durante el proceso de compra (impuestos incluidos).</p><h3>Momento y Método de Pago</h3><p>Pago inmediato a través de Square (tarjeta de crédito, etc.). Las suscripciones se cobrarán en cada fecha de renovación.</p><h3>Tiempo de Provisión del Servicio</h3><p>El servicio estará disponible inmediatamente después de completar el pago.</p><h3>Política de Cancelación y Reembolso</h3><p>・Debido a la naturaleza de los productos digitales, por regla general no se aceptan reembolsos ni devoluciones una vez completado el pago.<br>・Puede cancelar su suscripción en cualquier momento. Seguirá teniendo acceso al servicio hasta la fecha de expiración, incluso después de cancelar.<br>・No ofrecemos reembolsos prorrateados.</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('legal', false)">Cerrar</button>`,
        guideFileContent: `<b>【Guía Completa: Modo Archivo】</b><span class="guide-sub">1. Cargar Archivo</span><ul><li>Seleccione un archivo de música de su dispositivo para analizarlo. Los BPM se calcularán automáticamente.</li></ul><span class="guide-sub">2. Bucle AB (Selección de Rango)</span><ul><li>Arrastre en la onda para seleccionar un rango. Durante la reproducción, volverá automáticamente al inicio al llegar al final del rango.</li><li>Use "Borrar" para cancelar el bucle. Use "Guardar" para almacenar múltiples rangos por canción y cambiar entre ellos instantáneamente desde la lista de abajo.</li></ul><span class="guide-sub">3. Cambiar BPM y Tono</span><ul><li>Use el control de BPM para cambiar la velocidad (0.5x〜1.5x).</li><li>Use el control de Tono (Pitch) para cambiar la tonalidad en semitonos (±6). *Cambiar el tono requiere una suscripción.</li></ul><span class="guide-sub">4. Aceleración Automática</span><ul><li>Active el botón "⚡ (rayo)" y seleccione "Auto BPM Up". El BPM aumentará automáticamente en +0.05 cada vez que el bucle se repita el número de veces especificado (hasta volver al BPM original).</li></ul><span class="guide-sub">5. Grabación Propia</span><ul><li>Use el botón "mic" para grabar su propio sonido mientras reproduce.</li><li>Los datos grabados se muestran debajo de la onda, y puede ajustar el volumen de la pista principal y la grabación por separado.</li><li>Al activar el botón "S (Solo)", solo escuchará el sonido grabado.</li><li class="guide-note">*Para una grabación y sincronización precisas, recomendamos usar una PC y una interfaz de audio.</li><li class="guide-note">*En dispositivos móviles (teléfonos/tabletas), la operación inicial o la grabación pueden ser inestables debido a las limitaciones del navegador.</li></ul><span class="guide-sub">6. Actualizar Reproductor</span><ul><li>Si la reproducción de audio o la interacción de la forma de onda se vuelven inestables (especialmente en dispositivos móviles), toque el botón "Refresh" ubicado a la derecha del botón "FIT".</li><li>Esto reiniciará de forma segura el motor de audio manteniendo intactos su archivo cargado y la configuración de bucle.</li></ul><span class="guide-sub">【Preguntas Frecuentes (FAQ)】</span><ul><li><b>Sobre el cambio de correo electrónico:</b><br>Si desea cambiar su dirección de correo electrónico, cancele primero su suscripción actual y, una vez expire, regístrese nuevamente (nuevo pago) usando la nueva dirección de correo electrónico.</li></ul>`,
        guideYTContent: `<b>【Guía Completa: Modo YouTube】</b><span class="guide-sub">1. Cargar Video</span><ul><li>Pegue la URL de YouTube o busque una palabra clave y toque "CARGAR".</li><li>Los videos cargados se guardan en "HISTORIAL", lo que permite recargarlos rápidamente.</li></ul><span class="guide-sub">2. Configurar Bucle AB</span><ul><li>Use los botones "INICIO" y "FIN" para establecer la posición actual como el rango del bucle.</li><li>Con los botones "-1 / +1", puede ajustar finamente las posiciones de inicio y fin.</li><li>Use el botón "BUCLE ON/OFF" para activar o desactivar el bucle.</li></ul><span class="guide-sub">3. Guardar Bucles</span><ul><li>Use el botón "GUARDAR" para almacenar el rango configurado.</li><li>Los bucles guardados se enumeran por video y se pueden cargar instantáneamente tocando el icono del número.</li></ul><span class="guide-sub">【Preguntas Frecuentes (FAQ)】</span><ul><li><b>Sobre el cambio de correo electrónico:</b><br>Si desea cambiar su dirección de correo electrónico, cancele primero su suscripción actual y, una vez expire, regístrese nuevamente (nuevo pago) usando la nueva dirección de correo electrónico.</li></ul>`,
        installMobile: "Añadir a inicio", installDesktop: "Instalar en escritorio", iosInstallGuide: "Toca el botón Compartir [↑] en Safari y selecciona 'Añadir a la pantalla de inicio'.", installNotAvailable: "La instalación no es compatible en este navegador o ya está instalada.",
        trialWelcomeTitle: "¡Prueba Gratuita de 3 Días Iniciada!",
        trialWelcomeDesc: "¡Gracias por registrarse! Puedes usar todas las funciones premium gratis durante los próximos 3 días.",
        trialStartBtn: "Comenzar",
        subGuestTitle: "Premium / Prueba Gratis 3 Días",
        subGuestDesc: "¡Regístrate ahora para probar todas las funciones premium gratis durante 3 días!",
        subGuestRegBtn: "Regístrate y Pruébalo Gratis",
        subExpiredTitle: "Prueba Expirada",
        subExpiredDesc: "Su prueba gratuita ha finalizado.<br>Por favor, suscríbase para continuar usando todas las funciones premium.",
        planTrial: "Prueba de 3 Días ({days} días restantes)",
        planExpired: "GRATIS (Prueba Expirada)",
        subStart: "Suscribirse",
        subLogout: "Usar otra cuenta"
    },
    pt: {
        langTitle: "Idioma", helpTitle: "Ajuda e Guia", themeTitle: "Cor do Tema", guideFile: "Guia Modo Arquivo", guideYT: "Guia Modo YouTube", close: "Fechar", fit: "Ajustar", clear: "Limpar", ready: "PRONTO", analyzing: "ANALISANDO...", setStart: "INÍCIO", setEnd: "FIM", loopOff: "LOOP OFF", loopOn: "LOOP ON", fileSelect: "Selecionar Arquivo", saveLoop: "Salvar Loop", speedUpLabel: "Auto BPM Up", recPlay: "Reproduzir Grav.", recStop: "Parar", privacyMenu: "Política de Privacidade", legalMenu: "Aviso Legal", authDesc: "Entre com sua conta", googleBtn: "Entrar com Google", authDiv: "OU", authEmail: "Entrar / Cadastrar", historyTitle: "Histórico Recente", historyClear: "Limpar Tudo", keyLabel: "Tonalidade", majorKey: "maior", minorKey: "menor", ytLoad: "CARREGAR", recDel: "Excluir", ytPlaceholder: "URL do YouTube ou palavra-chave de busca...",
        accInfo: "Informações da Conta", deleteAcc: "Excluir Conta", accNameLabel: "Nome", accEmailLabel: "E-mail", accPlanLabel: "Plano", resetPw: "Redefinir Senha",
        authNote: "*Para novos cadastros, um e-mail de verificação será enviado. Abra o link no e-mail para concluir o cadastro.",
        msgLoginReq: "Faça login primeiro.", msgEmptyAuth: "Digite seu e-mail e senha.", msgRegConfirm: "Conta não encontrada. Um e-mail de verificação será enviado ao endereço informado para novo cadastro. Continuar?\n\n*O cadastro NÃO estará concluído até você clicar no URL do e-mail.", msgLoginErr: "Erro: ", msgMailSent: "E-mail de redefinição enviado. Verifique sua caixa de entrada.", msgDelHist: "Limpar histórico?", msgDelRec: "Excluir gravação?", msgDelAcc: "Isso excluirá permanentemente sua conta e todos os dados salvos.\n\n⚠️ IMPORTANTE: Excluir sua conta NÃO cancela automaticamente sua assinatura! Por favor, cancele o pagamento pelo e-mail de recibo do Square primeiro.\n\nTem certeza que deseja excluir?", msgDelAccSuccess: "Conta excluída com sucesso.", msgPwReset: "Enviar e-mail de redefinição de senha?", msgRangeReq: "Selecione um intervalo", msgRangeInv: "Intervalo inválido", msgSubConfirm: "⚠️ IMPORTANTE\nUse exatamente o mesmo e-mail na página de pagamento do Square.\n\nProsseguir para o pagamento?",
        forgotPw: "Esqueceu sua senha?", msgUnverified: "O endereço de e-mail não foi verificado. Clique no link do e-mail de verificação para concluir a autenticação. (Um novo e-mail de verificação foi reenviado)", msgVerifySent: "Um e-mail de verificação foi enviado. Clique no link do e-mail para concluir o cadastro e faça login novamente.", msgEnterEmailPwReset: "Digite seu endereço de e-mail para redefinir sua senha.", modalSubStartText: "Assinar", manageSubText: "Gerenciar / Cancelar Assinatura", msgManageSub: "Para gerenciar ou cancelar sua assinatura, use o link 'Gerenciar assinatura' no e-mail de recibo de pagamento do Square.",
        privacyInner: `<h2 style="color:var(--primary-color); margin-top:0;">Política de Privacidade</h2><p>A "AMS Music Studio", operada pela Anderson Studios (doravante "o Estúdio"), estabelece esta Política de Privacidade sobre o tratamento de informações pessoais no aplicativo "AMS Practice Player" (doravante "o App").</p><h3>1. Informações Coletadas</h3><p>O App coleta endereços de e-mail e nomes via Google Authentication, e status de pagamento via Square para gerenciamento de assinatura.</p><h3>2. Finalidade de Uso</h3><p>As informações coletadas são usadas exclusivamente para autenticação, gerenciamento de assinatura, suporte ao usuário e fornecimento das funcionalidades do App.</p><h3>3. Compartilhamento com Terceiros</h3><p>Não compartilhamos informações com terceiros sem consentimento, exceto quando exigido por lei. O App utiliza Google Firebase e Square.</p><h3>4. Contato</h3><p>Operador: Anderson Studios (AMS Music Studio)<br>Contato: ams.guitar.school@gmail.com</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('privacy', false)">Fechar</button>`,
        legalInner: `<h2 style="color:var(--primary-color); margin-top:0;">Aviso Legal</h2><h3>Operador</h3><p>Koichi Ashida (Anderson Studios / AMS Music Studio)</p><h3>Contato</h3><p>ams.guitar.school@gmail.com</p><h3>Preço</h3><p>Valor exibido durante o processo de compra (impostos incluídos).</p><h3>Pagamento</h3><p>Pagamento imediato via Square (cartão de crédito, etc.). As assinaturas são cobradas em cada data de renovação.</p><h3>Entrega</h3><p>O serviço fica disponível imediatamente após a conclusão do pagamento.</p><h3>Política de Cancelamento e Reembolso</h3><p>・Devido à natureza dos serviços digitais, reembolsos geralmente não são aceitos após o pagamento.<br>・As assinaturas podem ser canceladas a qualquer momento. O serviço permanece ativo até o fim do período atual.<br>・Não são fornecidos reembolsos proporcionais.</p><button class="clear-btn-ja" style="width:100%; margin-top:20px; padding:12px;" onclick="togglePolicy('legal', false)">Fechar</button>`,
        guideFileContent: `<b>【Guia Completo: Modo Arquivo】</b><span class="guide-sub">1. Carregar Arquivo</span><ul><li>Selecione um arquivo de música do seu dispositivo para análise. O BPM será calculado automaticamente.</li></ul><span class="guide-sub">2. Loop AB (Seleção de Intervalo)</span><ul><li>Arraste na forma de onda para selecionar um intervalo. Durante a reprodução, voltará automaticamente ao início ao atingir o fim do intervalo.</li><li>Use "Limpar" para cancelar o loop. Use "Salvar Loop" para armazenar vários intervalos por música e alternar entre eles instantaneamente.</li></ul><span class="guide-sub">3. Alterar BPM e Tom</span><ul><li>Use o controle de BPM para alterar a velocidade (0.5x〜1.5x).</li><li>Use o controle de Tom (Pitch) para alterar a tonalidade em semitons (±6). *Alterar o tom requer assinatura.</li></ul><span class="guide-sub">4. Aceleração Automática</span><ul><li>Ative o botão "⚡ (raio)" e selecione "Auto BPM Up". O BPM aumentará automaticamente +0.05 a cada vez que o loop se repetir o número de vezes especificado.</li></ul><span class="guide-sub">5. Gravação Própria</span><ul><li>Use o botão "mic" para gravar seu som enquanto reproduz.</li><li>Os dados gravados aparecem abaixo da forma de onda, e você pode ajustar o volume da faixa principal e da gravação separadamente.</li><li>Ao ativar o botão "S (Solo)", você ouvirá apenas o som gravado.</li><li class="guide-note">*Para gravação e sincronização precisas, recomendamos usar PC e interface de áudio.</li><li class="guide-note">*Em dispositivos móveis, a operação inicial ou gravação pode ser instável devido às limitações do navegador.</li></ul><span class="guide-sub">6. Atualizar Player</span><ul><li>Se a reprodução de áudio ou a interação com a forma de onda ficar instável (especialmente em dispositivos móveis), toque o botão "Refresh" à direita do botão "FIT".</li><li>Isso reinicia com segurança o mecanismo de áudio mantendo o arquivo carregado e as configurações de loop.</li></ul><span class="guide-sub">【Perguntas Frequentes (FAQ)】</span><ul><li><b>Sobre alteração de e-mail:</b><br>Se desejar alterar seu endereço de e-mail, cancele sua assinatura atual e, após o vencimento, cadastre-se novamente (novo pagamento) com o novo endereço.</li></ul>`,
        guideYTContent: `<b>【Guia Completo: Modo YouTube】</b><span class="guide-sub">1. Carregar Vídeo</span><ul><li>Cole a URL do YouTube ou pesquise por palavra-chave e toque em "CARREGAR".</li><li>Os vídeos carregados são salvos no "HISTÓRICO" para recarregamento rápido.</li></ul><span class="guide-sub">2. Configurar Loop AB</span><ul><li>Use os botões "INÍCIO" e "FIM" para definir a posição atual como intervalo do loop.</li><li>Com os botões "-1 / +1", ajuste fino das posições de início e fim.</li><li>Use o botão "LOOP ON/OFF" para ativar ou desativar o loop.</li></ul><span class="guide-sub">3. Salvar Loops</span><ul><li>Use o botão "SAVE" para armazenar o intervalo configurado.</li><li>Os loops salvos são listados por vídeo e podem ser carregados instantaneamente tocando no ícone numérico.</li></ul><span class="guide-sub">【Perguntas Frequentes (FAQ)】</span><ul><li><b>Sobre alteração de e-mail:</b><br>Se desejar alterar seu endereço de e-mail, cancele sua assinatura atual e, após o vencimento, cadastre-se novamente (novo pagamento) com o novo endereço.</li></ul>`,
        installMobile: "Adicionar à Tela Inicial", installDesktop: "Instalar no Desktop", iosInstallGuide: "Toque no botão Compartilhar [↑] no Safari e selecione 'Adicionar à Tela de Início'.", installNotAvailable: "A instalação não é suportada neste navegador ou o app já está instalado.",
        trialWelcomeTitle: "Teste Grátis de 3 Dias Iniciado!",
        trialWelcomeDesc: "Obrigado por se cadastrar! Você pode usar todas as funções premium gratuitamente pelos próximos 3 dias.",
        trialStartBtn: "Começar",
        subGuestTitle: "Premium / Teste Grátis 3 Dias",
        subGuestDesc: "Cadastre-se agora para testar todas as funções premium gratuitamente por 3 dias!",
        subGuestRegBtn: "Cadastrar e Testar Grátis",
        subExpiredTitle: "Teste Expirado",
        subExpiredDesc: "Seu teste gratuito terminou.<br>Por favor, assine para continuar usando todas as funções premium.",
        planTrial: "Teste Grátis de 3 Dias ({days} dias restantes)",
        planExpired: "GRÁTIS (Teste Expirado)",
        subStart: "Assinar",
        subLogout: "Entrar com outra conta"
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
let currentLoopCount = 0;
let isLoadingFile = false;

// ==================== PLAYLIST (IndexedDB) ====================
let playlistDB = null;
let currentPlaylistItemId = null;
const PLAYLIST_DB_NAME = 'ams_playlist_v1';
const PLAYLIST_STORE = 'tracks';

async function openPlaylistDB() {
    if (playlistDB) return playlistDB;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(PLAYLIST_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(PLAYLIST_STORE)) {
                db.createObjectStore(PLAYLIST_STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = (e) => { playlistDB = e.target.result; resolve(playlistDB); };
        req.onerror = (e) => reject(e.target.error);
    });
}

async function addFilesToPlaylist(files) {
    const db = await openPlaylistDB();
    const ids = [];
    for (const file of files) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const mimeType = (file.type && file.type.startsWith('audio/')) ? file.type : 'audio/mpeg';
            const blob = new Blob([arrayBuffer], { type: mimeType });
            const id = await new Promise((resolve, reject) => {
                const tx = db.transaction(PLAYLIST_STORE, 'readwrite');
                const req = tx.objectStore(PLAYLIST_STORE).add({ name: file.name, blob, addedAt: Date.now() });
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = reject;
            });
            ids.push(id);
        } catch (e) { console.error('Playlist add error:', file.name, e); }
    }
    renderPlaylist();
    return ids;
}

async function addBlobToPlaylist(name, blob) {
    const db = await openPlaylistDB();
    const id = await new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_STORE, 'readwrite');
        const req = tx.objectStore(PLAYLIST_STORE).add({ name, blob, addedAt: Date.now() });
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = reject;
    });
    renderPlaylist();
    return id;
}

async function getAllPlaylistItems() {
    const db = await openPlaylistDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_STORE, 'readonly');
        const req = tx.objectStore(PLAYLIST_STORE).getAll();
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function getPlaylistItem(id) {
    const db = await openPlaylistDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_STORE, 'readonly');
        const req = tx.objectStore(PLAYLIST_STORE).get(id);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

window.deletePlaylistItem = async (id) => {
    const db = await openPlaylistDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_STORE, 'readwrite');
        tx.objectStore(PLAYLIST_STORE).delete(id).onsuccess = resolve;
        tx.onerror = reject;
    });
    if (currentPlaylistItemId === id) currentPlaylistItemId = null;
    renderPlaylist();
};

async function clearAllPlaylist() {
    const lang = document.getElementById('langSelect').value || 'ja';
    const msg = lang === 'ja' ? 'プレイリストをすべて削除しますか？' : 'Clear all playlist items?';
    if (!confirm(msg)) return;
    const db = await openPlaylistDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_STORE, 'readwrite');
        tx.objectStore(PLAYLIST_STORE).clear().onsuccess = resolve;
        tx.onerror = reject;
    });
    currentPlaylistItemId = null;
    renderPlaylist();
}

async function renderPlaylist() {
    const container = document.getElementById('playlistItems');
    if (!container) return;
    let items = [];
    try { items = await getAllPlaylistItems(); } catch(e) { return; }

    if (items.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:var(--text-dim); font-size:0.75rem; padding:20px 0; line-height:1.8;">プレイリストが空です。<br>ファイルを追加してください。</div>';
        return;
    }

    container.innerHTML = '';
    items.forEach((item) => {
        const isActive = item.id === currentPlaylistItemId;
        const div = document.createElement('div');
        div.className = 'playlist-item-row' + (isActive ? ' active' : '');
        const name = item.name.length > 36 ? item.name.substring(0, 34) + '…' : item.name;
        div.innerHTML = `
            <span class="material-icons" style="font-size:18px; color:${isActive ? 'var(--primary-color)' : 'var(--text-dim)'}; flex-shrink:0;">${isActive ? 'music_note' : 'audiotrack'}</span>
            <span style="flex:1; font-size:0.75rem; color:${isActive ? '#fff' : '#ccc'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${item.name}">${name}</span>
            <button class="pl-btn" onclick="event.stopPropagation(); loadPlaylistItem(${item.id})" title="再生" style="color:var(--primary-color);">
                <span class="material-icons" style="font-size:22px;">play_circle</span>
            </button>
            <button class="pl-btn" onclick="event.stopPropagation(); deletePlaylistItem(${item.id})" title="削除" style="color:#ff5555;">
                <span class="material-icons" style="font-size:20px;">cancel</span>
            </button>
        `;
        div.onclick = () => loadPlaylistItem(item.id);
        container.appendChild(div);
    });
}

window.loadPlaylistItem = async (id) => {
    if (isLoadingFile) return;
    const item = await getPlaylistItem(id);
    if (!item) return;

    isLoadingFile = true;
    const ctx = initAudioContext();
    if (ctx && ctx.state === 'suspended') await ctx.resume();
    currentPlaylistItemId = id;

    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    const statusEl = document.getElementById('loadStatus');
    const fileSelectBtn = document.getElementById('fileSelectBtn');

    currentFileName = item.name;
    fileSelectBtn.innerText = item.name.length > 30 ? item.name.substring(0, 28) + '…' : item.name;
    statusEl.innerText = lang === 'ja' ? '読み込み中...' : 'Loading...';

    if (wavesurfer.isPlaying()) wavesurfer.pause();
    wsRegions.clearRegions();
    if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
    wavesurfer.empty();
    if (isMobile) await new Promise(r => setTimeout(r, 200));

    currentObjectURL = URL.createObjectURL(item.blob);

    const onDecodeP = () => {
        wavesurfer.un('error', onErrorP);
        analyzeAudio(item.blob);
        renderLoopList('file');
        isLoadingFile = false;
    };
    const onErrorP = (err) => {
        wavesurfer.un('decode', onDecodeP);
        console.error('Playlist load error:', err);
        statusEl.innerText = lang === 'ja' ? '読み込みエラー' : 'Load Error';
        if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
        isLoadingFile = false;
    };
    wavesurfer.once('decode', onDecodeP);
    wavesurfer.once('error', onErrorP);
    wavesurfer.load(currentObjectURL);
    renderPlaylist();
};

async function playNextPlaylistItem() {
    const items = await getAllPlaylistItems();
    if (items.length === 0) return;
    const currentIndex = items.findIndex(item => item.id === currentPlaylistItemId);
    const nextIndex = currentIndex + 1;
    if (nextIndex < items.length) {
        await loadPlaylistItem(items[nextIndex].id);
        wavesurfer.once('ready', () => {
            setTimeout(() => { if (currentMode === 'file') wavesurfer.play().catch(() => {}); }, 300);
        });
    }
}

function togglePlaylistPanel() {
    const panel = document.getElementById('playlistPanel');
    if (!panel) return;
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) renderPlaylist();
}
// ==================== END PLAYLIST ====================

function changeLanguage() {
    const lang = document.getElementById('langSelect').value || 'ja'; 
    const t = translations[lang] || translations['ja']; 
    
    document.getElementById('langTitle').innerText = t.langTitle; 
    document.getElementById('helpTitle').innerText = t.helpTitle; 
    document.getElementById('themeTitle').innerText = t.themeTitle; 
    document.getElementById('guideFileTitle').innerText = t.guideFile; 
    document.getElementById('guideYTTitle').innerText = t.guideYT; 
    document.getElementById('privacyMenu').innerText = t.privacyMenu; 
    document.getElementById('legalMenu').innerText = t.legalMenu; 
    document.getElementById('closeBtn1').innerText = t.close; 
    document.getElementById('closeBtn2').innerText = t.close; 
    document.getElementById('resetZoomBtn').innerText = t.fit; 
    document.getElementById('clearRangeBtn').innerHTML = `<span class="material-icons" style="font-size:18px;">layers_clear</span><span style="font-size:0.65rem; white-space:nowrap;">${t.clear}</span>`; 
    document.getElementById('saveLoopBtn').innerHTML = `<span class="material-icons" style="font-size:18px;">bookmark_add</span><span style="font-size:0.65rem; white-space:nowrap;">${t.saveLoop}</span>`; 
    document.getElementById('speedUpLabel').innerText = t.speedUpLabel; 
    document.getElementById('setStartBtn').innerText = t.setStart; 
    document.getElementById('setEndBtn').innerText = t.setEnd; 
    document.getElementById('authDesc').innerText = t.authDesc; 
    document.getElementById('googleLoginBtnTxt').innerText = t.googleBtn; 
    document.getElementById('authDivider').innerText = t.authDiv; 
    document.getElementById('emailLoginBtnTxt').innerText = t.authEmail; 
    document.getElementById('authCloseBtn').innerText = t.close; 
    document.getElementById('subCloseBtn').innerText = t.close; 
    document.getElementById('ytLoadBtnTxt').innerText = t.ytLoad; 
    
    const histTitle = document.getElementById('historyTitle');
    if(histTitle) histTitle.innerText = t.historyTitle;
    const histClearBtn = document.getElementById('historyClearBtn');
    if(histClearBtn) histClearBtn.innerText = t.historyClear;
    const keyLabelEl = document.getElementById('keyLabel');
    if(keyLabelEl) keyLabelEl.innerText = t.keyLabel || 'Key';
    
    document.getElementById('guideFileContent').innerHTML = t.guideFileContent; 
    document.getElementById('guideYTContent').innerHTML = t.guideYTContent; 
    document.getElementById('privacyPolicyInner').innerHTML = t.privacyInner; 
    document.getElementById('legalNoticeInner').innerHTML = t.legalInner; 
    
    const fileLabel = document.getElementById('fileSelectBtn'); 
    if (fileLabel.innerText.includes("ファイル") || fileLabel.innerText.includes("Select") || fileLabel.innerText.includes("选择") || fileLabel.innerText.includes("선택") || fileLabel.innerText.includes("Elegir")) fileLabel.innerText = t.fileSelect; 
    
    const loadS = document.getElementById('loadStatus'); 
    if (loadS.innerText.includes("READY") || loadS.innerText.includes("準備") || loadS.innerText.includes("就绪") || loadS.innerText.includes("준비") || loadS.innerText.includes("LISTO")) loadS.innerText = t.ready; 
    
    const b = document.getElementById('toggleLoopBtn'); 
    if(b) b.innerText = isLooping ? t.loopOn : t.loopOff; 
    
    const recDel = document.getElementById('recDelBtnTxt'); 
    if(recDel) recDel.innerHTML = `<span class="material-icons" style="font-size:14px;">delete</span> ${t.recDel}`; 
    
    const ytInput = document.getElementById('ytUrl');
    if (ytInput) ytInput.placeholder = t.ytPlaceholder || "YouTube URL or Search Keyword...";
    
    const trialTitleEl = document.getElementById('trialWelcomeTitle');
    if(trialTitleEl) trialTitleEl.innerText = t.trialWelcomeTitle;
    const trialDescEl = document.getElementById('trialWelcomeDesc');
    if(trialDescEl) trialDescEl.innerText = t.trialWelcomeDesc;
    const trialBtnEl = document.getElementById('trialStartBtn');
    if(trialBtnEl) trialBtnEl.innerText = t.trialStartBtn;

    const authNoteEl = document.getElementById('authNoteTxt');
    if(authNoteEl) authNoteEl.innerText = t.authNote;

    updateRecPlayBtnUI(); 
    if(auth.currentUser) updateAccountModalUI(auth.currentUser); 
    document.getElementById('accountMenuItem').innerText = t.accInfo; 
    document.getElementById('resetPwText').innerText = t.resetPw; 
    const forgotBtn = document.getElementById('forgotPwBtnTxt'); 
    if(forgotBtn) forgotBtn.innerText = t.forgotPw; 
    document.getElementById('updateBtnText').innerText = lang === 'ja' ? 'アップデートを確認' : 'Check for Updates'; 
    updateInstallButton(); 
}

function updateRecPlayBtnUI() { const lang = document.getElementById('langSelect').value || 'ja'; const t = translations[lang] || translations['ja']; const btn = document.getElementById('playRecBtn'); if (recWavesurfer && recWavesurfer.isPlaying()) btn.innerHTML = `<span class="material-icons" style="font-size:14px;">stop_circle</span> ${t.recStop}`; else if(btn) btn.innerHTML = `<span class="material-icons" style="font-size:14px;">play_circle</span> ${t.recPlay}`; }
function toggleMenu(isOpen) { document.getElementById('sideMenu').classList.toggle('open', isOpen); document.getElementById('menuOverlay').style.display = isOpen ? 'block' : 'none'; }
function showGuide(type) { toggleMenu(false); closeModals(); if (type === 'file') document.getElementById('guideModalFile').style.display = 'block'; if (type === 'yt') document.getElementById('guideModalYT').style.display = 'block'; document.getElementById('menuOverlay').style.display = 'block'; }
function closeModals() { document.getElementById('guideModalFile').style.display = 'none'; document.getElementById('guideModalYT').style.display = 'none'; document.getElementById('menuOverlay').style.display = 'none'; }
function initAudioContext() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); return audioCtx; }
function toggleSolo() { isSolo = !isSolo; document.getElementById('soloBtn').classList.toggle('active', isSolo); applyVolumes(); }
function applyVolumes() { if (!wavesurfer) return; const mVol = parseFloat(document.getElementById('mainVolume').value); const rVol = parseFloat(document.getElementById('recVolume').value); if (isSolo) wavesurfer.setMuted(true); else { wavesurfer.setMuted(false); wavesurfer.setVolume(mVol); } if (recWavesurfer && recObjectURL) recWavesurfer.setVolume(rVol); document.getElementById('mainVolTxt').innerText = Math.round(mVol * 100) + "%"; document.getElementById('recVolTxt').innerText = Math.round(rVol * 100) + "%"; }
async function toggleFeature(type) { if (type === 'count') { isCountEnabled = !isCountEnabled; document.getElementById('countToggleBtn').classList.toggle('active', isCountEnabled); } else if (type === 'speedup') { if (!await requireSubscription()) return; isSpeedUpEnabled = !isSpeedUpEnabled; document.getElementById('speedUpToggleBtn').classList.toggle('active', isSpeedUpEnabled); const selectEl = document.getElementById('speedUpCount'); selectEl.disabled = !isSpeedUpEnabled; currentLoopCount = 0; } }
function switchMode(mode) { currentMode = mode; document.getElementById('file-section').classList.toggle('active', mode === 'file'); document.getElementById('yt-section').classList.toggle('active', mode === 'yt'); document.getElementById('gp-section').classList.toggle('active', mode === 'gp'); document.getElementById('tab-file').classList.toggle('active', mode === 'file'); document.getElementById('tab-yt').classList.toggle('active', mode === 'yt'); document.getElementById('tab-gp').classList.toggle('active', mode === 'gp'); if(mode !== 'file' && wavesurfer) wavesurfer.pause(); if(mode === 'yt') { renderYTHistory(); } if(mode !== 'yt' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); if(mode === 'gp') { initGpMode(); } else if (gpApi) { try { gpApi.pause(); } catch(e){} } }

/* ===== TAB譜（Guitar Pro / MusicXML）モード — AlphaTab ===== */
let gpApi = null;
let gpInitialized = false;
let gpScore = null;
const GP_CDN = "https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/";

function gpStatus(msg) { const el = document.getElementById('gpLoadStatus'); if (el) el.innerText = msg || ''; }

function initGpMode() {
    if (gpInitialized) return;
    gpInitialized = true;
    // AlphaTab本体の読込確認
    if (typeof alphaTab === 'undefined' || !alphaTab.AlphaTabApi) {
        gpStatus('楽譜エンジンの読み込みに失敗しました。通信環境を確認して再読み込みしてください。');
        return;
    }
    const main = document.getElementById('gpMain');
    const viewport = document.getElementById('gpViewport');
    try {
        gpApi = new alphaTab.AlphaTabApi(main, {
            core: { fontDirectory: GP_CDN + 'font/' },
            // 楽譜の全記号をGuitar Pro準拠で忠実に描画（既定のGuitarProモードを明示）
            notation: { notationMode: alphaTab.NotationMode.GuitarPro, fingeringMode: alphaTab.FingeringMode.ScoreDefault },
            display: { layoutMode: alphaTab.LayoutMode.Page, scale: 1.0 },
            player: {
                enablePlayer: true,
                // 常に内蔵シンセで再生（GP7以降の埋め込みバッキング音源だと楽譜のテンポ/リピートに追従せずズレるため）
                playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
                enableCursor: true,
                enableUserInteraction: true,
                soundFont: GP_CDN + 'soundfont/sonivox.sf2',
                scrollElement: viewport,
                scrollMode: alphaTab.ScrollMode.Continuous
            }
        });
    } catch (e) {
        console.error('AlphaTab init error:', e);
        gpStatus('楽譜エンジンの初期化に失敗しました。');
        return;
    }

    gpApi.scoreLoaded.on(score => {
        gpScore = score;
        document.getElementById('gpTitle').innerText = score.title || '(無題)';
        document.getElementById('gpArtist').innerText = score.artist || '';
        document.getElementById('gpEmpty').style.display = 'none';
        document.getElementById('gpPlayerWrap').style.display = 'block';
        renderGpTrackList(score);
    });
    gpApi.renderStarted.on(() => gpStatus('楽譜を描画中...'));
    gpApi.renderFinished.on(() => gpStatus(''));
    gpApi.soundFontLoad.on(e => { if (e && e.total) gpStatus('音源を読み込み中... ' + Math.floor((e.loaded / e.total) * 100) + '%'); });
    gpApi.playerReady.on(() => gpStatus(''));
    gpApi.playerStateChanged.on(args => {
        const playing = args.state === alphaTab.synth.PlayerState.Playing;
        document.getElementById('gpPlayIcon').innerText = playing ? 'pause' : 'play_arrow';
    });
    gpApi.error.on(err => { console.error('AlphaTab error:', err); gpStatus('読み込みエラー: ' + (err && err.message ? err.message : 'ファイルを確認してください')); });

    // ファイル選択
    document.getElementById('gpFile').addEventListener('change', async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        try {
            gpStatus('ファイルを読み込み中...');
            const buf = await file.arrayBuffer();
            gpApi.load(new Uint8Array(buf));
        } catch (e) {
            console.error(e);
            gpStatus('このファイルは読み込めませんでした。対応形式か確認してください。');
        }
    });

    // 再生コントロール
    document.getElementById('gpPlayBtn').onclick = () => { initAudioContext(); if (gpApi) gpApi.playPause(); };
    document.getElementById('gpStopBtn').onclick = () => { if (gpApi) gpApi.stop(); };
    document.getElementById('gpLoopBtn').onclick = (e) => { if (!gpApi) return; gpApi.isLooping = !gpApi.isLooping; e.currentTarget.classList.toggle('active', gpApi.isLooping); };
    document.getElementById('gpMetroBtn').onclick = (e) => { if (!gpApi) return; const on = gpApi.metronomeVolume > 0; gpApi.metronomeVolume = on ? 0 : 1; e.currentTarget.classList.toggle('active', !on); };
    document.getElementById('gpCountBtn').onclick = (e) => { if (!gpApi) return; const on = gpApi.countInVolume > 0; gpApi.countInVolume = on ? 0 : 1; e.currentTarget.classList.toggle('active', !on); };

    // スピード
    const spd = document.getElementById('gpSpeed');
    spd.oninput = () => { if (gpApi) gpApi.playbackSpeed = parseFloat(spd.value); document.getElementById('gpSpeedTxt').innerText = 'x' + parseFloat(spd.value).toFixed(2); };
    document.getElementById('gpSpeedReset').onclick = () => { spd.value = 1.0; spd.oninput(); };

    // ズーム
    const zoom = document.getElementById('gpZoom');
    zoom.oninput = () => {
        const v = parseFloat(zoom.value);
        document.getElementById('gpZoomTxt').innerText = Math.round(v * 100) + '%';
        if (gpApi) { gpApi.settings.display.scale = v; gpApi.updateSettings(); gpApi.render(); }
    };
    document.getElementById('gpZoomReset').onclick = () => { zoom.value = 1.0; zoom.oninput(); };
}

function renderGpTrackList(score) {
    const list = document.getElementById('gpTrackList');
    if (!list) return;
    list.innerHTML = '';
    // 「すべて表示」
    const allItem = document.createElement('div');
    allItem.className = 'gp-track-item active';
    allItem.innerHTML = '<span class="gp-track-name">すべてのトラックを表示</span>';
    allItem.onclick = () => { gpApi.renderTracks(score.tracks); _setActiveTrackItem(allItem); };
    list.appendChild(allItem);

    score.tracks.forEach(track => {
        const item = document.createElement('div');
        item.className = 'gp-track-item';
        const name = document.createElement('span');
        name.className = 'gp-track-name';
        name.innerText = track.name || ('Track ' + (track.index + 1));
        item.appendChild(name);
        const mute = document.createElement('button');
        mute.className = 'gp-track-mute';
        mute.innerText = 'ミュート';
        mute.onclick = (e) => { e.stopPropagation(); const m = !mute.classList.contains('muted'); mute.classList.toggle('muted', m); gpApi.changeTrackMute([track], m); };
        item.appendChild(mute);
        // トラック名クリックでそのトラックのみ表示
        name.onclick = () => { gpApi.renderTracks([track]); _setActiveTrackItem(item); };
        list.appendChild(item);
    });
}
function _setActiveTrackItem(activeEl) {
    document.querySelectorAll('#gpTrackList .gp-track-item').forEach(el => el.classList.toggle('active', el === activeEl));
}

async function forceRefreshPlayer() {
    if (currentMode !== 'file' || !currentObjectURL) return;
    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    const statusEl = document.getElementById('loadStatus');
    statusEl.innerText = "REFRESHING...";

    try {
        if (audioCtx && audioCtx.state === 'suspended') { await audioCtx.resume(); } else { initAudioContext(); }
        const currentTime = wavesurfer.getCurrentTime();
        const currentRegions = wsRegions.getRegions().map(r => ({ start: r.start, end: r.end }));
        
        wavesurfer.pause(); wavesurfer.empty(); wsRegions.clearRegions();
        if (isMobile) await new Promise(r => setTimeout(r, 150));
        wavesurfer.load(currentObjectURL);
        wavesurfer.once('ready', () => {
            const currentColor = localStorage.getItem('ams_theme_color') || '#d4a373';
            currentRegions.forEach(r => { wsRegions.addRegion({ start: r.start, end: r.end, color: getRegionColor(currentColor) }); });
            wavesurfer.setTime(currentTime); statusEl.innerText = t.ready || "READY";
            document.getElementById('speed').dispatchEvent(new Event('input'));
        });
    } catch(e) { console.error("Refresh error:", e); statusEl.innerText = "ERROR"; }
}

async function analyzeAudio(blob) { 
    const lang = document.getElementById('langSelect').value || 'ja'; 
    const statusEl = document.getElementById('loadStatus'); 
    statusEl.innerText = translations[lang].analyzing; 
    const ctx = initAudioContext(); 
    try { 
        const arrayBuffer = await blob.arrayBuffer(); 
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer); 
        const data = audioBuffer.getChannelData(0); 
        let skip = 0; 
        const threshold = 0.015; 
        for (let i = 0; i < data.length; i += 100) { if (Math.abs(data[i]) > threshold) { skip = i / audioBuffer.sampleRate; break; } } 
        firstSoundTime = skip; 
        const bpm = detectBPM(audioBuffer);
        if (bpm > 0) originalBpm = Math.round(bpm); else originalBpm = 120;
        updateBpmDisplay();
        const keyResult = detectKey(audioBuffer);
        updateKeyDisplay(keyResult);
        statusEl.innerText = translations[lang].ready;
        if(wavesurfer && !wavesurfer.isPlaying()) { wavesurfer.setTime(firstSoundTime); }
    } catch (e) { console.error("Analysis error:", e); statusEl.innerText = translations[lang].ready; }
}

function multiplyBpm(factor) { if (originalBpm <= 0) return; const newBpm = originalBpm * factor; if (newBpm < 40 || newBpm > 300) return; originalBpm = Math.round(newBpm); updateBpmDisplay(); }
function updateBpmDisplay() { const currentSpeed = parseFloat(document.getElementById('speed').value); const currentBpm = Math.round(originalBpm * currentSpeed); const bpmEl = document.getElementById('spTxt'); if (bpmEl) bpmEl.innerText = "BPM " + (originalBpm > 0 ? currentBpm : "---"); }
function detectBPM(buffer) { const data = buffer.getChannelData(0), sampleRate = buffer.sampleRate, step = 200, energy = []; for (let i = 0; i < data.length; i += step) { let sum = 0; for(let j=0; j<step && (i+j)<data.length; j++) sum += data[i+j] * data[i+j]; energy.push(Math.sqrt(sum/step)); } let bestBpm = 0, maxCorrelation = 0; const minInterval = Math.floor((60 / 200) * (sampleRate / step)), maxInterval = Math.floor((60 / 60) * (sampleRate / step)); for (let interval = minInterval; interval <= maxInterval; interval++) { let correlation = 0; for (let i = 0; i < Math.min(energy.length - interval, 10000); i++) correlation += energy[i] * energy[i + interval]; if (correlation > maxCorrelation) { maxCorrelation = correlation; bestBpm = 60 / (interval * step / sampleRate); } } return (bestBpm < 50 || bestBpm > 250) ? 0 : bestBpm; }
function _nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function _fftMag(signal) {
    const N = signal.length;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = signal[i];
    // bit-reversal
    let j = 0;
    for (let i = 1; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    // butterfly
    for (let len = 2; len <= N; len <<= 1) {
        const ang = -2 * Math.PI / len, wRe = Math.cos(ang), wIm = Math.sin(ang);
        for (let i = 0; i < N; i += len) {
            let cRe = 1, cIm = 0;
            for (let k = 0; k < len >> 1; k++) {
                const uRe = re[i+k], uIm = im[i+k];
                const vRe = re[i+k+(len>>1)]*cRe - im[i+k+(len>>1)]*cIm;
                const vIm = re[i+k+(len>>1)]*cIm + im[i+k+(len>>1)]*cRe;
                re[i+k] = uRe+vRe; im[i+k] = uIm+vIm;
                re[i+k+(len>>1)] = uRe-vRe; im[i+k+(len>>1)] = uIm-vIm;
                const nr = cRe*wRe - cIm*wIm; cIm = cRe*wIm + cIm*wRe; cRe = nr;
            }
        }
    }
    const mag = new Float64Array(N >> 1);
    for (let i = 0; i < (N >> 1); i++) mag[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    return mag;
}
function detectKey(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const raw = audioBuffer.getChannelData(0);
    // Downsample to ~8000 Hz
    const factor = Math.max(1, Math.floor(sampleRate / 8000));
    const dsRate = sampleRate / factor;
    const maxRaw = Math.min(raw.length, sampleRate * 90); // up to 90 sec
    const dsLen = Math.floor(maxRaw / factor);
    const fftSize = Math.min(16384, _nextPow2(dsLen));
    // Hann window
    const hann = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    // Chromagram accumulation
    const chroma = new Float64Array(12);
    let wCount = 0;
    for (let start = 0; start + fftSize <= dsLen; start += fftSize) {
        const frame = new Float64Array(fftSize);
        for (let i = 0; i < fftSize; i++) { const ri = (start + i) * factor; if (ri < raw.length) frame[i] = raw[ri] * hann[i]; }
        const mag = _fftMag(frame);
        for (let bin = 1; bin < fftSize >> 1; bin++) {
            const freq = bin * dsRate / fftSize;
            if (freq < 65.41 || freq > 1975.5) continue; // C2–B6
            const midi = 12 * Math.log2(freq / 440) + 69;
            const pc = ((Math.round(midi) % 12) + 12) % 12;
            chroma[pc] += mag[bin] * mag[bin];
        }
        wCount++;
    }
    if (wCount === 0) return null;
    // Normalize
    const maxC = Math.max(...chroma);
    if (maxC === 0) return null;
    for (let i = 0; i < 12; i++) chroma[i] /= maxC;
    // Krumhansl-Schmuckler profiles
    const majP = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
    const minP = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
    const notes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    function pearson(a, b) {
        const n = a.length, mA = a.reduce((s,v)=>s+v,0)/n, mB = b.reduce((s,v)=>s+v,0)/n;
        let num=0, dA=0, dB=0;
        for (let i=0;i<n;i++){num+=(a[i]-mA)*(b[i]-mB);dA+=(a[i]-mA)**2;dB+=(b[i]-mB)**2;}
        return num/(Math.sqrt(dA*dB)||1);
    }
    let bestCorr=-Infinity, bestKey='C', bestMode='major';
    for (let root=0; root<12; root++) {
        const rot = Array.from({length:12},(_,i)=>chroma[(i+root)%12]);
        const mj = pearson(rot, majP), mn = pearson(rot, minP);
        if (mj > bestCorr) { bestCorr=mj; bestKey=notes[root]; bestMode='major'; }
        if (mn > bestCorr) { bestCorr=mn; bestKey=notes[root]; bestMode='minor'; }
    }
    return { key: bestKey, mode: bestMode };
}
function updateKeyDisplay(keyResult) {
    const el = document.getElementById('keyDisplay');
    const rowEl = document.getElementById('keyRow');
    if (!el || !rowEl) return;
    if (!keyResult) { rowEl.style.display = 'none'; return; }
    const lang = document.getElementById('langSelect').value || 'ja';
    const t = translations[lang] || translations['ja'];
    const modeStr = keyResult.mode === 'major' ? (t.majorKey || 'major') : (t.minorKey || 'minor');
    el.innerText = keyResult.key + ' ' + modeStr;
    rowEl.style.display = 'flex';
}
function playBeep(isLast) { const ctx = initAudioContext(); const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.frequency.setValueAtTime(isLast ? 880 : 440, ctx.currentTime); gain.gain.setValueAtTime(0.1, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1); osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.1); }
async function runCountdown() { if (!isCountEnabled) return true; const currentSpeed = parseFloat(document.getElementById('speed').value); const interval = 60000 / (originalBpm * currentSpeed); const overlay = document.getElementById('countdown-overlay'); overlay.style.display = 'block'; for (let i = 1; i <= 4; i++) { overlay.innerText = i; playBeep(i === 4); await new Promise(r => setTimeout(r, interval)); } overlay.style.display = 'none'; return true; }
async function toggleRecording() { if (!await requireSubscription()) return; initAudioContext(); if (isRecording) { if (mediaRecorder) mediaRecorder.stop(); if (wavesurfer.isPlaying()) wavesurfer.pause(); isRecording = false; document.getElementById('recBtn').classList.remove('recording'); document.getElementById('recIcon').innerText = 'mic'; } else { try { const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'; mediaRecorder = new MediaRecorder(stream, { mimeType }); recordedChunks = []; mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); }; mediaRecorder.onstop = async () => { const blob = new Blob(recordedChunks, { type: mimeType }); if (recObjectURL) URL.revokeObjectURL(recObjectURL); recObjectURL = URL.createObjectURL(blob); const arrayBuffer = await blob.arrayBuffer(); const ctx = initAudioContext(); recordedAudioBuffer = await ctx.decodeAudioData(arrayBuffer); document.getElementById('rec-waveform-wrapper').style.display = 'block'; document.getElementById('recVolControl').style.display = 'flex'; document.getElementById('recControls').style.display = 'flex'; await recWavesurfer.load(recObjectURL); applyVolumes(); updateRecPlayBtnUI(); stream.getTracks().forEach(track => track.stop()); }; const region = wsRegions.getRegions()[0]; const startPos = region ? region.start : wavesurfer.getCurrentTime(); wavesurfer.setTime(startPos); lastRecStartPos = startPos; await runCountdown(); mediaRecorder.start(); await wavesurfer.play(); isRecording = true; document.getElementById('recBtn').classList.add('recording'); document.getElementById('recIcon').innerText = 'stop'; } catch (err) { alert("マイクを許可してください"); } } }
function playRecording() { if (!recWavesurfer || !recObjectURL) return; initAudioContext(); if (recWavesurfer.isPlaying()) { recWavesurfer.pause(); wavesurfer.pause(); } else { const currentTime = wavesurfer.getCurrentTime(); const offset = currentTime - lastRecStartPos; if (offset >= 0 && offset < recWavesurfer.getDuration()) { recWavesurfer.setTime(offset); wavesurfer.play(); recWavesurfer.play(); } else { wavesurfer.setTime(lastRecStartPos); recWavesurfer.setTime(0); wavesurfer.play(); recWavesurfer.play(); } } updateRecPlayBtnUI(); }
function deleteRecording() { if (confirm(getMsg('msgDelRec'))) { document.getElementById('rec-waveform-wrapper').style.display = 'none'; document.getElementById('recControls').style.display = 'none'; document.getElementById('recVolControl').style.display = 'none'; if (recWavesurfer) { recWavesurfer.pause(); recWavesurfer.empty(); } if (recObjectURL) { URL.revokeObjectURL(recObjectURL); recObjectURL = null; } recordedAudioBuffer = null; isSolo = false; document.getElementById('soloBtn').classList.remove('active'); applyVolumes(); } }

const tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(tag);

window.toggleYTResults = () => {
    const res = document.getElementById('ytSearchResults');
    res.style.display = (res.style.display === 'none' || res.style.display === '') ? 'block' : 'none';
};

function loadYouTube(manualUrl = null) { 
    initAudioContext(); 
    const urlInput = document.getElementById('ytUrl'); 
    const query = manualUrl || urlInput.value.trim(); 
    if (!query) return; 

    const isUrl = query.includes('youtube.com') || query.includes('youtu.be') || query.startsWith('http');

    if (isUrl) {
        document.getElementById('ytSearchResults').style.display = 'none';
        const videoId = query.includes('v=') ? query.split('v=')[1].split('&')[0] : query.includes('be/') ? query.split('be/')[1].split('?')[0] : null; 
        if (videoId) { 
            currentYTId = videoId; 
            document.getElementById('loopListYT').innerHTML = ""; 
            loopStart = 0; loopEnd = 0; isLooping = false; 
            document.getElementById('loopStartTxt').innerText = "00:00"; 
            document.getElementById('loopEndTxt').innerText = "00:00"; 
            const b = document.getElementById('toggleLoopBtn'); 
            const lang = document.getElementById('langSelect').value || 'ja'; 
            if(b) { b.innerText = translations[lang].loopOff; b.classList.remove('active'); } 
            
            resetYTSpeed();

            if (ytPlayer && ytPlayer.loadVideoById) {
                ytPlayer.loadVideoById(videoId); 
            } else {
                ytPlayer = new YT.Player('player', { 
                    videoId: videoId, 
                    events: { 'onReady': () => { updateYTInfo(); }, 'onStateChange': onPlayerStateChange } 
                }); 
            }
            urlInput.value = ""; 
        } 
    } else {
        searchYouTube(query);
    }
}

async function searchYouTube(keyword) {
    const resultsContainer = document.getElementById('ytSearchResults');
    const toggleBtn = document.getElementById('ytToggleResultsBtn');
    
    toggleBtn.style.display = 'none';
    
    if (!YOUTUBE_API_KEY) {
        if (confirm("APIキーが設定されていないため、アプリ内で直接検索ができません。\nYouTubeの検索画面を別タブで開きますか？\n（動画を開いた後、URLをコピーしてここに貼り付けてください）")) {
            window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`, '_blank');
        }
        return;
    }

    resultsContainer.innerHTML = "<div style='padding:15px; color:var(--primary-color); font-size:0.85rem; font-weight:bold; text-align:center;'>検索中...</div>";
    resultsContainer.style.display = 'block';

    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${encodeURIComponent(keyword)}&type=video&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();

        if (data.items && data.items.length > 0) {
            toggleBtn.style.display = 'flex';
            
            resultsContainer.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.1); position:sticky; top:0; background:rgba(15,15,20,0.95); z-index:10; backdrop-filter:blur(5px);">
                    <span style="font-size:0.7rem; color:var(--text-dim); font-weight:bold; letter-spacing:1px;">SEARCH RESULTS</span>
                    <button onclick="document.getElementById('ytSearchResults').style.display='none'" class="reset-btn" style="display:flex; align-items:center; justify-content:center; padding:4px;"><span class="material-icons" style="font-size:16px;">close</span></button>
                </div>
            `;
            
            data.items.forEach(item => {
                const vid = item.id.videoId;
                const title = item.snippet.title;
                const thumb = item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : item.snippet.thumbnails.default.url;
                const channel = item.snippet.channelTitle;

                const div = document.createElement('div');
                div.style = "display:flex; gap:12px; align-items:center; padding:10px; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; transition:background 0.2s;";
                div.onmouseover = () => div.style.background = "rgba(255,255,255,0.1)";
                div.onmouseout = () => div.style.background = "transparent";
                div.onclick = () => {
                    document.getElementById('ytUrl').value = `https://www.youtube.com/watch?v=${vid}`;
                    loadYouTube();
                    resultsContainer.style.display = 'none';
                };

                div.innerHTML = `
                    <img src="${thumb}" style="width:110px; height:62px; object-fit:cover; border-radius:6px; flex-shrink:0; box-shadow: 0 2px 8px rgba(0,0,0,0.5);">
                    <div style="display:flex; flex-direction:column; overflow:hidden;">
                        <span style="font-size:0.85rem; color:#fff; margin-bottom:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-overflow:ellipsis; line-height:1.3;">${title}</span>
                        <span style="font-size:0.65rem; color:var(--text-dim);">${channel}</span>
                    </div>
                `;
                resultsContainer.appendChild(div);
            });
        } else {
            resultsContainer.innerHTML = `
                <div style="display:flex; justify-content:flex-end; padding:8px;">
                    <button onclick="document.getElementById('ytSearchResults').style.display='none'" class="reset-btn"><span class="material-icons" style="font-size:16px;">close</span></button>
                </div>
                <div style='padding:15px; color:#a0a0a5; font-size:0.8rem; text-align:center;'>動画が見つかりませんでした。</div>
            `;
        }
    } catch (error) {
        console.error("YouTube Search Error:", error);
        resultsContainer.innerHTML = `
            <div style="display:flex; justify-content:flex-end; padding:8px;">
                <button onclick="document.getElementById('ytSearchResults').style.display='none'" class="reset-btn"><span class="material-icons" style="font-size:16px;">close</span></button>
            </div>
            <div style='padding:15px; color:#ff5555; font-size:0.8rem; text-align:center;'>検索エラーが発生しました。<br>APIキーの制限等の可能性があります。</div>
        `;
    }
}

window.toggleYTPlay = () => {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    const state = ytPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
    } else {
        ytPlayer.playVideo();
    }
};

window.ytSkip = (seconds) => {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    const currentTime = ytPlayer.getCurrentTime();
    ytPlayer.seekTo(currentTime + seconds, true);
};

window.changeYTSpeed = (val) => {
    if (!ytPlayer || !ytPlayer.setPlaybackRate) return;
    const rate = parseFloat(val);
    ytPlayer.setPlaybackRate(rate);
    document.getElementById('ytSpeedTxt').innerText = 'x' + rate.toFixed(2);
};

window.resetYTSpeed = () => {
    document.getElementById('ytSpeed').value = 1.0;
    changeYTSpeed(1.0);
};

function saveToHistory(id, title) { let history = JSON.parse(localStorage.getItem('ams_yt_history') || "[]"); history = history.filter(item => item.id !== id); history.unshift({ id: id, title: title || id, url: `https://www.youtube.com/watch?v=${id}`, time: Date.now() }); if (history.length > 20) history.pop(); localStorage.setItem('ams_yt_history', JSON.stringify(history)); renderYTHistory(); syncToCloud(); }
function renderYTHistory() {
    const historyList = document.getElementById('ytHistoryList');
    const toggleBtn = document.getElementById('ytHistoryToggleBtn');
    if (!historyList) return;
    const history = JSON.parse(localStorage.getItem('ams_yt_history') || "[]");
    if (toggleBtn) toggleBtn.style.display = history.length > 0 ? 'flex' : 'none';
    if (history.length === 0) {
        const container = document.getElementById('ytHistoryContainer');
        if (container) container.style.display = 'none';
        historyList.innerHTML = '';
        return;
    }
    historyList.innerHTML = '';
    history.forEach(item => {
        const div = document.createElement('div');
        div.style = 'display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.04); cursor:pointer; transition:background 0.2s; min-height:52px;';
        div.onmouseover = () => div.style.background = 'rgba(255,255,255,0.07)';
        div.onmouseout = () => div.style.background = 'transparent';
        const thumb = `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`;
        div.innerHTML = `
            <img src="${thumb}" style="width:72px; height:40px; object-fit:cover; border-radius:5px; flex-shrink:0; background:#111;" onerror="this.style.display='none'">
            <span style="flex:1; font-size:0.78rem; color:#e0e0e0; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.35;">${item.title}</span>
            <button onclick="event.stopPropagation(); deleteHistoryItem('${item.id}')" style="background:none; border:none; color:#ff5555; cursor:pointer; padding:4px; display:flex; align-items:center; min-width:32px; min-height:32px; justify-content:center; flex-shrink:0;">
                <span class="material-icons" style="font-size:18px;">cancel</span>
            </button>
        `;
        div.onclick = async (e) => {
            if (e.target.closest('button')) return;
            if (!await requireSubscription()) return;
            loadYouTube(item.url);
            const container = document.getElementById('ytHistoryContainer');
            if (container) container.style.display = 'none';
        };
        historyList.appendChild(div);
    });
}
function toggleYTHistoryPanel() {
    const container = document.getElementById('ytHistoryContainer');
    if (!container) return;
    const isVisible = container.style.display !== 'none';
    if (isVisible) {
        container.style.display = 'none';
    } else {
        document.getElementById('ytSearchResults').style.display = 'none';
        container.style.display = 'block';
    }
}
function handleHistoryClick(event) { const card = event.target.closest('div[data-url]'); if (card) { if (!isSubscribed) { openSubOverlay(); return; } loadYouTube(card.getAttribute('data-url')); } }
window.deleteHistoryItem = (id) => { let history = JSON.parse(localStorage.getItem('ams_yt_history') || "[]"); history = history.filter(item => item.id !== id); localStorage.setItem('ams_yt_history', JSON.stringify(history)); renderYTHistory(); syncToCloud(); };
window.clearYTHistory = () => { if (confirm(getMsg('msgDelHist'))) { localStorage.removeItem('ams_yt_history'); renderYTHistory(); syncToCloud(); } };
function updateYTInfo() { const data = ytPlayer.getVideoData(); if (data && data.video_id) { saveToHistory(data.video_id, data.title); renderLoopList('yt'); } }

function onPlayerStateChange(e) { 
    const playIcon = document.getElementById('ytPlayIcon');
    
    if (e.data === YT.PlayerState.PLAYING) { 
        if (playIcon) playIcon.innerText = 'pause';
        updateYTInfo(); 
        loopInterval = setInterval(() => { 
            if (isLooping && ytPlayer.getCurrentTime() >= loopEnd) ytPlayer.seekTo(loopStart); 
        }, 200); 
    } else { 
        if (playIcon) playIcon.innerText = 'play_arrow';
        clearInterval(loopInterval); 
    } 
}

const fmt = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
window.setLoopPoint = (t) => { const now = ytPlayer.getCurrentTime(); if (t === 'start') { loopStart = Math.floor(now); document.getElementById('loopStartTxt').innerText = fmt(loopStart); } else { loopEnd = Math.ceil(now); document.getElementById('loopEndTxt').innerText = fmt(loopEnd); } };
window.adjustTime = (t, a) => { if (t === 'start') { loopStart = Math.max(0, loopStart + a); document.getElementById('loopStartTxt').innerText = fmt(loopStart); ytPlayer.seekTo(loopStart); } else { loopEnd = Math.max(loopStart + 1, loopEnd + a); document.getElementById('loopEndTxt').innerText = fmt(loopEnd); } };
window.toggleLoop = () => { isLooping = !isLooping; const lang = document.getElementById('langSelect').value || 'ja'; const b = document.getElementById('toggleLoopBtn'); if(b) { b.innerText = isLooping ? translations[lang].loopOn : translations[lang].loopOff; b.classList.toggle('active', isLooping); } };

async function saveLoop(mode) { if (!await requireSubscription()) return; let start, end, key; if (mode === 'file') { const regions = wsRegions.getRegions(); if (regions.length === 0) return alert(getMsg('msgRangeReq')); start = regions[0].start; end = regions[0].end; key = currentFileName; } else { if (!currentYTId) return; start = loopStart; end = loopEnd; key = currentYTId; if (start >= end) return alert(getMsg('msgRangeInv')); } let storageKey = mode === 'file' ? 'ams_loops' : 'ams_yt_loops'; let allLoops = JSON.parse(localStorage.getItem(storageKey) || "{}"); if (!allLoops[key]) allLoops[key] = []; allLoops[key].push({ start, end }); localStorage.setItem(storageKey, JSON.stringify(allLoops)); renderLoopList(mode); syncToCloud(); }
function getCircleNum(n) { const circles = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"]; return circles[n-1] || `(${n})`; }
function renderLoopList(mode) { const container = mode === 'file' ? document.getElementById('loopListFile') : document.getElementById('loopListYT'); const key = mode === 'file' ? currentFileName : currentYTId; const storageKey = mode === 'file' ? 'ams_loops' : 'ams_yt_loops'; if(!container) return; container.innerHTML = ""; if (!key) return; let allLoops = JSON.parse(localStorage.getItem(storageKey) || "{}"); (allLoops[key] || []).forEach((loop, index) => { const badge = document.createElement('div'); badge.className = 'loop-badge'; badge.onclick = () => applyStoredLoop(mode, loop.start, loop.end); badge.innerHTML = `<span class="badge-num">${getCircleNum(index + 1)}</span><span class="material-icons badge-del" style="font-size:16px; transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'" onclick="event.stopPropagation(); deleteLoop('${mode}', ${index})">cancel</span>`; container.appendChild(badge); }); }
window.applyStoredLoop = async (mode, start, end) => { if (!await requireSubscription()) return; initAudioContext(); if (mode === 'file') { wsRegions.clearRegions(); const currentColor = localStorage.getItem('ams_theme_color') || '#d4a373'; wsRegions.addRegion({ start, end, color: getRegionColor(currentColor) }); wavesurfer.setTime(start); } else { loopStart = start; loopEnd = end; document.getElementById('loopStartTxt').innerText = fmt(start); document.getElementById('loopEndTxt').innerText = fmt(end); ytPlayer.seekTo(start); if (!isLooping) toggleLoop(); } };
window.deleteLoop = (mode, index) => { const storageKey = mode === 'file' ? 'ams_loops' : 'ams_yt_loops'; const key = mode === 'file' ? currentFileName : currentYTId; let allLoops = JSON.parse(localStorage.getItem(storageKey) || "{}"); if (allLoops[key]) { allLoops[key].splice(index, 1); localStorage.setItem(storageKey, JSON.stringify(allLoops)); renderLoopList(mode); syncToCloud(); } };

function startApp() { 
    let lastTime = 0; 
    const initColor = localStorage.getItem('ams_theme_color') || '#d4a373';
    wavesurfer = WaveSurfer.create({ container: '#waveform', waveColor: '#444', progressColor: initColor, height: 120, barWidth: 2, normalize: true }); 
    recWavesurfer = WaveSurfer.create({ container: '#rec-waveform', waveColor: '#552222', progressColor: '#ff4444', height: 80, barWidth: 2, normalize: true }); 
    wsRegions = wavesurfer.registerPlugin(WaveSurfer.Regions.create()); 
    wsRegions.enableDragSelection({ color: getRegionColor(initColor) }); 
    wsRegions.on('region-created', r => { const regions = wsRegions.getRegions(); regions.forEach(region => { if (region.id !== r.id) { region.remove(); } }); wavesurfer.setTime(r.start); lastTime = r.start; currentLoopCount = 0; }); 
    wsRegions.on('region-update-end', r => { const duration = r.end - r.start; if (duration < 0.1) { r.remove(); return; } wavesurfer.setTime(r.start); lastTime = r.start; currentLoopCount = 0; });
    document.getElementById('zoomSlider').oninput = (e) => wavesurfer.zoom(Number(e.target.value)); 
    document.getElementById('resetZoomBtn').onclick = () => { wavesurfer.zoom(0); document.getElementById('zoomSlider').value = 0; }; 
    document.getElementById('mainVolume').oninput = applyVolumes; 
    document.getElementById('recVolume').oninput = applyVolumes; 
    
    // =========================================================
    // モバイル向けファイル読み込み（安定化対応版）
    // =========================================================
    const audioFileInput = document.getElementById('audioFile');
    const fileSelectBtn = document.getElementById('fileSelectBtn');

    // iOSのAudioContext事前アンロック
    // touchend のみで処理し、click では何もしない（二重発火防止）
    if (isMobile) {
        let touchFired = false;
        fileSelectBtn.addEventListener('touchstart', () => {
            touchFired = true;
            // タッチ操作タイミングでAudioContextを起動・再開
            const ctx = initAudioContext();
            if (ctx && ctx.state === 'suspended') ctx.resume();
        }, { passive: true });

        // touchend: value リセット（同一ファイル再選択対応）
        fileSelectBtn.addEventListener('touchend', (e) => {
            audioFileInput.value = '';
        }, { passive: true });

        // click イベントは touchend の直後にも発火するため、
        // touch 操作の場合は click での value リセットをスキップ
        fileSelectBtn.addEventListener('click', () => {
            if (touchFired) { touchFired = false; return; }
            audioFileInput.value = '';
        });
    } else {
        // PC: click のみで value リセット
        fileSelectBtn.addEventListener('click', () => {
            audioFileInput.value = '';
        });
    }

    audioFileInput.addEventListener('change', async (e) => {
        // 二重ロード防止
        if (isLoadingFile) return;
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;

        // 複数ファイル選択 → 全てプレイリストに追加して最初の曲を読み込む
        if (files.length > 1) {
            isLoadingFile = true;
            const langM = document.getElementById('langSelect').value || 'ja';
            document.getElementById('loadStatus').innerText = langM === 'ja' ? '追加中...' : 'Adding...';
            try {
                const ids = await addFilesToPlaylist(files);
                if (ids.length > 0) {
                    document.getElementById('playlistPanel').style.display = 'block';
                    await loadPlaylistItem(ids[0]);
                }
            } catch(err) { console.error('Multi-file load error:', err); }
            isLoadingFile = false;
            e.target.value = '';
            return;
        }

        const file = files[0];
        isLoadingFile = true;
        const lang = document.getElementById('langSelect').value || 'ja';
        const t = translations[lang] || translations['ja'];
        const statusEl = document.getElementById('loadStatus');

        try {
            // ユーザー操作イベント内でAudioContextを起動（iOS必須）
            const ctx = initAudioContext();
            if (ctx && ctx.state === 'suspended') await ctx.resume();

            currentFileName = file.name;
            const displayName = file.name.length > 30 ? file.name.substring(0, 28) + '…' : file.name;
            fileSelectBtn.innerText = displayName;
            statusEl.innerText = lang === 'ja' ? '読み込み中...' : 'Loading...';

            // 再生停止・リージョンクリア
            if (wavesurfer.isPlaying()) wavesurfer.pause();
            wsRegions.clearRegions();

            // 古いObjectURLを解放
            if (currentObjectURL) {
                URL.revokeObjectURL(currentObjectURL);
                currentObjectURL = null;
            }

            // wavesurfer の内部状態をリセット（前のファイルの残骸を除去）
            wavesurfer.empty();

            // モバイルは empty() 後に少し待機してDOMを安定させる
            if (isMobile) await new Promise(r => setTimeout(r, 200));

            // Google DriveなどクラウドストレージのファイルはArrayBufferとして
            // 先に完全読み込みしてからObjectURLを生成する（モバイル安定化）
            let fileBlob;
            try {
                const arrayBuffer = await file.arrayBuffer();
                const mimeType = (file.type && file.type.startsWith('audio/')) ? file.type : 'audio/mpeg';
                fileBlob = new Blob([arrayBuffer], { type: mimeType });
            } catch (readErr) {
                fileBlob = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => {
                        const mimeType = (file.type && file.type.startsWith('audio/')) ? file.type : 'audio/mpeg';
                        resolve(new Blob([e.target.result], { type: mimeType }));
                    };
                    reader.onerror = reject;
                    reader.readAsArrayBuffer(file);
                });
            }

            currentObjectURL = URL.createObjectURL(fileBlob);

            // 読み込み完了・エラー時のハンドラを一度だけ登録
            const onDecode = () => {
                wavesurfer.un('error', onError);
                analyzeAudio(fileBlob);
                renderLoopList('file');
                // プレイリストにも追加（バックグラウンド）
                addBlobToPlaylist(file.name, fileBlob).then(id => {
                    currentPlaylistItemId = id;
                    renderPlaylist();
                }).catch(() => {});
                isLoadingFile = false;
            };
            const onError = (err) => {
                wavesurfer.un('decode', onDecode);
                console.error('Wavesurfer load error:', err);
                statusEl.innerText = lang === 'ja' ? '読み込みエラー' : 'Load Error';
                fileSelectBtn.innerText = t.fileSelect || 'ファイルを選択';
                if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
                currentFileName = '';
                audioFileInput.value = '';
                isLoadingFile = false;
            };
            wavesurfer.once('decode', onDecode);
            wavesurfer.once('error', onError);

            wavesurfer.load(currentObjectURL);

        } catch (err) {
            console.error('File load error:', err);
            statusEl.innerText = lang === 'ja' ? '読み込みエラー' : 'Load Error';
            fileSelectBtn.innerText = t.fileSelect || 'ファイルを選択';
            audioFileInput.value = '';
            isLoadingFile = false;
        }
    });

    const applySettings = () => { 
        const s = parseFloat(document.getElementById('speed').value);
        const p = parseInt(document.getElementById('pitch').value); 
        const media = wavesurfer.getMediaElement(); 
        if (media) { 
            let targetRate = s; let targetPreservesPitch = true;
            if (media.detune !== undefined) { if(media.detune !== p * 100) media.detune = p * 100; } else { if (p !== 0) { targetPreservesPitch = false; targetRate = s * Math.pow(2, p / 12); } } 
            if(media.preservesPitch !== targetPreservesPitch) { media.preservesPitch = targetPreservesPitch; }
            if(Math.abs(wavesurfer.getPlaybackRate() - targetRate) > 0.001) { wavesurfer.setPlaybackRate(targetRate); }
        } 
        updateBpmDisplay(); document.getElementById('pitchTxt').innerText = (p > 0 ? "+" : "") + p; applyVolumes(); 
    }; 

    wavesurfer.on('ready', () => { document.getElementById('totalTime').innerText = fmt(wavesurfer.getDuration()); applySettings(); });
    recWavesurfer.on('finish', () => { wavesurfer.pause(); updateRecPlayBtnUI(); });
    wavesurfer.on('finish', async () => { document.getElementById('playIcon').innerText = 'play_arrow'; if (recWavesurfer) recWavesurfer.pause(); if (currentPlaylistItemId !== null) { await playNextPlaylistItem(); } });
    document.getElementById('speed').oninput = applySettings; 
    document.getElementById('pitch').onmousedown = document.getElementById('pitch').ontouchstart = async (e) => { if (!await requireSubscription()) { e.preventDefault(); } }; 
    document.getElementById('pitch').oninput = applySettings; 
    
    document.getElementById('playBtn').onclick = async () => { 
        const ctx = initAudioContext();
        if (ctx && ctx.state === 'suspended') await ctx.resume();
        if (wavesurfer.isPlaying()) { wavesurfer.pause(); return; } 
        const media = wavesurfer.getMediaElement();
        if (media && media.paused) { const p = media.play(); if (p !== undefined) { p.catch(() => {}); } media.pause(); }
        const current = wavesurfer.getCurrentTime();
        const region = wsRegions.getRegions()[0]; 
        if (isCountEnabled && region && (current < region.start || current >= region.end - 0.05)) { wavesurfer.setTime(region.start); lastTime = region.start; }
        if (isCountEnabled) { await runCountdown(); }
        applySettings();
        if (ctx && ctx.state === 'suspended') await ctx.resume();
        setTimeout(() => { wavesurfer.play().catch(e => console.error("Play interrupted:", e)); }, 10);
    }; 

    wavesurfer.on('play', () => { document.getElementById('playIcon').innerText = 'pause'; if (recObjectURL && recWavesurfer) { const offset = wavesurfer.getCurrentTime() - lastRecStartPos; if (offset >= 0 && offset < recWavesurfer.getDuration()) { recWavesurfer.setTime(offset); recWavesurfer.play(); } } }); 
    wavesurfer.on('pause', () => { document.getElementById('playIcon').innerText = 'play_arrow'; if (recWavesurfer) recWavesurfer.pause(); }); 
    wavesurfer.on('seeking', () => { lastTime = wavesurfer.getCurrentTime(); });
    wavesurfer.on('interaction', () => { if (recObjectURL && recWavesurfer) { const currentTime = wavesurfer.getCurrentTime(); const offset = currentTime - lastRecStartPos; if (offset >= 0 && offset < recWavesurfer.getDuration()) recWavesurfer.setTime(offset); else recWavesurfer.setTime(0); if (wavesurfer.isPlaying()) recWavesurfer.play(); } currentLoopCount = 0; lastTime = wavesurfer.getCurrentTime(); }); 
    recWavesurfer.on('interaction', () => { if (!recObjectURL) return; const recTime = recWavesurfer.getCurrentTime(); const targetMainTime = lastRecStartPos + recTime; if (targetMainTime <= wavesurfer.getDuration()) wavesurfer.setTime(targetMainTime); if (wavesurfer.isPlaying()) wavesurfer.play(); }); 
    
    wavesurfer.on('timeupdate', t => { 
        document.getElementById('currentTime').innerText = fmt(t); 
        if (wavesurfer.isPlaying() && recObjectURL && recWavesurfer && recWavesurfer.isPlaying()) { const expectedRecTime = t - lastRecStartPos; const actualRecTime = recWavesurfer.getCurrentTime(); if (Math.abs(actualRecTime - expectedRecTime) > 0.2) { if (expectedRecTime >= 0 && expectedRecTime < recWavesurfer.getDuration()) recWavesurfer.setTime(expectedRecTime); else recWavesurfer.pause(); } } 
        const r = wsRegions.getRegions()[0]; 
        const isNaturalPlay = (t - lastTime) >= 0 && (t - lastTime) < 0.5;
        if(r && isNaturalPlay && lastTime <= r.end && t >= r.end) { 
            if (isRecording) { toggleRecording(); } else { 
                wavesurfer.setTime(r.start); t = r.start; 
                if (recObjectURL && recWavesurfer) { const loopOffset = r.start - lastRecStartPos; if (loopOffset >= 0 && loopOffset < recWavesurfer.getDuration()) recWavesurfer.setTime(loopOffset); } 
                if (isSpeedUpEnabled) { currentLoopCount++; const targetCount = parseInt(document.getElementById('speedUpCount').value); if (currentLoopCount >= targetCount) { const sInput = document.getElementById('speed'); const currentVal = parseFloat(sInput.value); if (currentVal < 1.0) { sInput.value = Math.min(1.0, currentVal + 0.05).toFixed(2); applySettings(); } currentLoopCount = 0; } } 
            } 
        } 
        lastTime = t;
    });

    window.resetSetting = (id, val) => { document.getElementById(id).value = val; applySettings(); }; 
    openPlaylistDB().then(() => renderPlaylist()).catch(() => {});
    const playlistAddInputEl = document.getElementById('playlistAddInput');
    if (playlistAddInputEl) {
        playlistAddInputEl.addEventListener('change', async (e) => {
            const addFiles = Array.from(e.target.files || []);
            if (addFiles.length === 0) return;
            const langA = document.getElementById('langSelect').value || 'ja';
            document.getElementById('loadStatus').innerText = langA === 'ja' ? '追加中...' : 'Adding...';
            await addFilesToPlaylist(addFiles);
            e.target.value = '';
            document.getElementById('loadStatus').innerText = translations[langA]?.ready || 'READY';
            document.getElementById('playlistPanel').style.display = 'block';
        });
    }
    changeLanguage();
    renderYTHistory();

    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.code === 'Space') { 
            e.preventDefault(); 
            if (currentMode === 'file') document.getElementById('playBtn').click();
            else if (currentMode === 'yt') toggleYTPlay();
            else if (currentMode === 'gp' && gpApi) { initAudioContext(); gpApi.playPause(); }
        }
        else if (e.code === 'ArrowLeft') { 
            e.preventDefault(); 
            if (currentMode === 'file' && wavesurfer) wavesurfer.skip(-5); 
            if (currentMode === 'yt' && ytPlayer) ytSkip(-5); 
        } 
        else if (e.code === 'ArrowRight') { 
            e.preventDefault(); 
            if (currentMode === 'file' && wavesurfer) wavesurfer.skip(5); 
            if (currentMode === 'yt' && ytPlayer) ytSkip(5); 
        } 
        else if ((e.code === 'KeyR' || e.key.toLowerCase() === 'r') && currentMode === 'file') { 
            e.preventDefault(); 
            toggleRecording(); 
        }
    });
    
    setThemeColor(initColor);
    updateInstallButton();

    // バックグラウンドから復帰した際にAudioContextを自動再開（モバイル安定化）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    });
}
window.addEventListener('DOMContentLoaded', startApp);
