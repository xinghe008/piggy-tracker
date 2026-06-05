// ============================================================
// 🐷 甜心小猪捕捉器 - 监控端 (Dashboard)
// 功能：实时位置追踪、电量监控、历史轨迹回放
// 通信：Gun.js P2P 实时数据库（无需后端服务器）
// 地图：高德地图 JS API 2.0
// ============================================================

// ---- 全局状态 ----
let map, AMapObj, markers = {}, historyPolyline = null, historyMarkers = [];
let isHistoryOpen = false, isPlaying = false, playInterval = null;
let isDarkMap = false;
let activeDeviceId = null;
let gun, roomNode;
let roomId = '';
let devices = {}; // { deviceId: { name, emoji, lat, lng, battery, charging, address, online, lastUpdate, history } }
let deviceHistory = {}; // { deviceId: [{ lat, lng, time, battery, address }] }

// ---- 高德地图配置 ----
// 使用高德 JS API 2.0（需要替换为你自己的 Key）
// 申请地址：https://console.amap.com/dev/key/app
const AMAP_KEY = 'YOUR_AMAP_KEY'; // ⚠️ 请替换为你的高德 Key
const AMAP_SECURITY_CODE = 'YOUR_SECURITY_CODE'; // ⚠️ 请替换为你的安全密钥

// ---- 初始化 ----
function init() {
    // 从 URL 获取房间号
    const params = new URLSearchParams(window.location.search);
    roomId = params.get('room') || generateRoomId();
    updateRoomDisplay();

    // 初始化 Gun.js
    initGun();

    // 初始化地图
    initAMap();

    // 初始化 UI
    createFloatingHearts();
    updateHeaderTime();
    renderSidebar();

    // 定时更新
    setInterval(updateHeaderTime, 1000);

    // 速度滑块
    document.getElementById('speedSlider')?.addEventListener('input', function() {
        document.getElementById('speedLabel').textContent = this.value + 'x';
        if (isPlaying) { stopPlay(); playHistory(); }
    });

    // 如果 URL 没有房间号，更新 URL（方便分享）
    if (!params.get('room')) {
        window.history.replaceState({}, '', '?room=' + roomId);
    }
}

// ---- 生成房间号 ----
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ---- 更新房间号显示 ----
function updateRoomDisplay() {
    document.getElementById('roomIdDisplay').textContent = roomId;
}

// ---- 复制房间链接 ----
function copyRoomLink() {
    const baseUrl = window.location.origin + window.location.pathname;
    const monitorLink = baseUrl + '?room=' + roomId;
    const authLink = baseUrl.replace('index.html', 'auth.html') + '?room=' + roomId;

    const text = `🐷 甜心小猪捕捉器\n\n📋 监控端（你的）：${monitorLink}\n🔗 授权链接（发给对方）：${authLink}\n\n把授权链接发给对方，对方打开后授权即可开始守护！`;

    navigator.clipboard.writeText(text).then(() => {
        showToast('链接已复制！把授权链接发给对方吧 🐷');
    }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('链接已复制！把授权链接发给对方吧 🐷');
    });
}

// ---- 创建新房间 ----
function createNewRoom() {
    if (confirm('创建新房间将断开当前所有连接，确定吗？')) {
        roomId = generateRoomId();
        updateRoomDisplay();
        window.history.replaceState({}, '', '?room=' + roomId);
        // 重新订阅新房间
        initGun();
        devices = {};
        deviceHistory = {};
        Object.values(markers).forEach(m => { if(m && m.setMap) m.setMap(null); });
        markers = {};
        renderSidebar();
        showToast('新房间已创建！记得分享新的授权链接 🐷');
    }
}

// ============================================================
// Gun.js 实时通信
// ============================================================
function initGun() {
    try {
        gun = Gun({
            peers: ['https://relay.peer.ooo/gun']
        });
        roomNode = gun.get('piggy-tracker-' + roomId);

        // 监听设备数据
        roomNode.map().on(function(data, key) {
            if (!key || !data) return;
            if (key.startsWith('device-')) {
                handleDeviceUpdate(key.replace('device-', ''), data);
            }
        });
    } catch (e) {
        console.warn('Gun.js 初始化失败，使用本地模拟模式', e);
        startDemoMode();
    }
}

// ---- 处理设备数据更新 ----
function handleDeviceUpdate(deviceId, data) {
    const isNew = !devices[deviceId];

    devices[deviceId] = {
        id: deviceId,
        name: data.name || '小猪',
        emoji: data.emoji || '🐷',
        lat: data.lat || 39.9042,
        lng: data.lng || 116.4074,
        battery: data.battery ?? 100,
        charging: data.charging || false,
        address: data.address || '未知位置',
        online: data.online !== false,
        lastUpdate: data.lastUpdate ? new Date(data.lastUpdate) : new Date(),
        speed: data.speed || 0
    };

    // 记录历史轨迹
    if (!deviceHistory[deviceId]) deviceHistory[deviceId] = [];
    const last = deviceHistory[deviceId][deviceHistory[deviceId].length - 1];
    const now = new Date();
    // 只在位置变化超过5米或间隔超过30秒时记录
    if (!last || 
        Math.abs(last.lat - devices[deviceId].lat) > 0.00005 ||
        Math.abs(last.lng - devices[deviceId].lng) > 0.00005 ||
        (now - new Date(last.time)) > 30000) {
        deviceHistory[deviceId].push({
            lat: devices[deviceId].lat,
            lng: devices[deviceId].lng,
            time: now.toISOString(),
            battery: devices[deviceId].battery,
            address: devices[deviceId].address
        });
        // 最多保留500个点
        if (deviceHistory[deviceId].length > 500) {
            deviceHistory[deviceId] = deviceHistory[deviceId].slice(-500);
        }
    }

    // 更新地图标记
    updateMapMarker(deviceId);

    // 更新 UI
    renderSidebar();

    // 如果是第一个设备，自动选中并定位
    if (isNew && Object.keys(devices).length === 1) {
        activeDeviceId = deviceId;
        centerOnDevice();
    }

    // 更新底部信息
    if (deviceId === activeDeviceId) {
        updateBottomInfo(devices[deviceId]);
    }

    if (isNew) {
        showToast(`${devices[deviceId].emoji} ${devices[deviceId].name} 已上线！`);
    }
}

// ---- 演示模式（Gun.js 不可用时） ----
function startDemoMode() {
    showToast('演示模式：使用模拟数据 🐷');
    const demoDevices = [
        { id: 'demo1', name: '小明', emoji: '👦', lat: 39.9042, lng: 116.4074, battery: 78, address: '北京市东城区天安门广场' },
        { id: 'demo2', name: '小红', emoji: '👧', lat: 39.9142, lng: 116.3974, battery: 32, charging: true, address: '北京市西城区西单商业街' }
    ];
    demoDevices.forEach(d => {
        handleDeviceUpdate(d.id, d);
    });
    // 模拟位置更新
    setInterval(() => {
        Object.keys(devices).forEach(id => {
            const dev = devices[id];
            dev.lat += (Math.random() - 0.5) * 0.0003;
            dev.lng += (Math.random() - 0.5) * 0.0003;
            dev.battery = Math.max(5, dev.battery - Math.random() * 0.3);
            dev.battery = Math.round(dev.battery);
            dev.lastUpdate = new Date();
            handleDeviceUpdate(id, dev);
        });
    }, 5000);
}

// ============================================================
// 高德地图
// ============================================================
function initAMap() {
    // 动态加载高德地图 JS API 2.0
    if (AMAP_KEY === 'YOUR_AMAP_KEY') {
        console.warn('未配置高德 API Key，使用 Leaflet + 高德瓦片作为后备方案');
        initLeafletFallback();
        return;
    }

    // 设置安全密钥
    window._AMapSecurityConfig = {
        securityJsCode: AMAP_SECURITY_CODE
    };

    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&plugin=AMap.Geocoder`;
    script.onload = () => {
        AMapObj = new AMap.Map('map', {
            zoom: 15,
            center: [116.397428, 39.90923],
            mapStyle: 'amap://styles/fresh',
            zooms: [3, 18]
        });
        showToast('高德地图加载成功！🐷');
    };
    script.onerror = () => {
        console.warn('高德地图加载失败，使用后备方案');
        initLeafletFallback();
    };
    document.head.appendChild(script);
}

// ---- Leaflet 后备方案（无需 API Key） ----
function initLeafletFallback() {
    map = L.map('map', {
        center: [39.9042, 116.4074],
        zoom: 15,
        zoomControl: false
    });

    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
        subdomains: ['1', '2', '3', '4'],
        attribution: '© 高德地图',
        maxZoom: 18
    }).addTo(map);
}

// ---- 更新地图标记 ----
function updateMapMarker(deviceId) {
    const dev = devices[deviceId];
    if (!dev) return;

    if (AMapObj) {
        // 高德地图标记
        if (markers[deviceId]) {
            markers[deviceId].setPosition([dev.lng, dev.lat]);
        } else {
            const markerContent = document.createElement('div');
            markerContent.innerHTML = `
                <div style="position:relative;text-align:center;">
                    <div style="width:60px;height:60px;border-radius:50%;background:rgba(255,107,157,0.15);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);animation:markerPulse 2s infinite;"></div>
                    <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#FF6B9D,#E84580);border:3px solid white;box-shadow:0 3px 14px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;font-size:24px;position:relative;z-index:1;">${dev.emoji}</div>
                </div>
            `;
            markers[deviceId] = new AMap.Marker({
                position: [dev.lng, dev.lat],
                content: markerContent,
                offset: new AMap.Pixel(-24, -24),
                map: AMapObj
            });
        }
    } else if (map) {
        // Leaflet 标记
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `
                <div class="marker-pulse" style="background:rgba(255,107,157,0.15);"></div>
                <div class="marker-avatar" style="background:linear-gradient(135deg,#FF6B9D,#E84580);">${dev.emoji}</div>
            `,
            iconSize: [48, 48],
            iconAnchor: [24, 24]
        });
        if (markers[deviceId]) {
            markers[deviceId].setLatLng([dev.lat, dev.lng]);
        } else {
            markers[deviceId] = L.marker([dev.lat, dev.lng], { icon: icon }).addTo(map);
            markers[deviceId].bindPopup(`
                <div style="text-align:center;min-width:150px;">
                    <strong style="font-size:15px;">${dev.emoji} ${dev.name}</strong><br>
                    <span style="color:#8D6E63;font-size:12px;">${dev.address}</span><br>
                    <span style="font-size:12px;">🔋 ${dev.battery}%</span>
                </div>
            `);
        }
    }
}

// ---- 定位到设备 ----
function centerOnDevice() {
    const dev = devices[activeDeviceId];
    if (!dev) {
        const firstId = Object.keys(devices)[0];
        if (firstId) { activeDeviceId = firstId; centerOnDevice(); }
        return;
    }
    if (AMapObj) {
        AMapObj.setZoomAndCenter(16, [dev.lng, dev.lat], false, 600);
    } else if (map) {
        map.flyTo([dev.lat, dev.lng], 16, { duration: 1 });
        markers[activeDeviceId]?.openPopup();
    }
}

// ---- 切换地图样式 ----
function toggleMapStyle() {
    if (AMapObj) {
        isDarkMap = !isDarkMap;
        AMapObj.setMapStyle(isDarkMap ? 'amap://styles/dark' : 'amap://styles/fresh');
        showToast(isDarkMap ? '已切换为暗色地图 🌙' : '已切换为清新地图 🌸');
    } else if (map) {
        // Leaflet 模式下切换高德瓦片样式
        isDarkMap = !isDarkMap;
        map.eachLayer(layer => { if (layer instanceof L.TileLayer) map.removeLayer(layer); });
        const style = isDarkMap ? '7' : '8';
        L.tileLayer(`https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=${style}&x={x}&y={y}&z={z}`, {
            subdomains: ['1', '2', '3', '4'],
            attribution: '© 高德地图',
            maxZoom: 18
        }).addTo(map);
        showToast(isDarkMap ? '已切换为暗色地图 🌙' : '已切换为清新地图 🌸');
    }
}

// ============================================================
// 侧边栏 UI
// ============================================================
function renderSidebar() {
    const sidebar = document.getElementById('sidebar');
    const deviceIds = Object.keys(devices);

    let html = '<div class="sidebar-title"><i class="fas fa-heart"></i> 我的小可爱们</div>';

    if (deviceIds.length === 0) {
        html += `
            <div class="no-device-hint">
                <span class="hint-icon">🐷</span>
                <p>还没有小猪连接哦～<br>把授权链接发给对方吧！</p>
                <ol class="hint-steps">
                    <li>点击上方「分享链接」按钮</li>
                    <li>把授权链接发给对方</li>
                    <li>对方打开链接并授权</li>
                    <li>就可以看到对方的位置啦！</li>
                </ol>
            </div>
        `;
    } else {
        deviceIds.forEach(id => {
            const dev = devices[id];
            const isActive = id === activeDeviceId;
            const batteryClass = dev.battery > 60 ? 'high' : dev.battery > 20 ? 'medium' : 'low';
            const chargingIcon = dev.charging ? ' <i class="fas fa-bolt" style="color:#FFA726;font-size:11px;"></i>' : '';
            const batteryIcon = dev.battery > 75 ? 'fa-battery-full' :
                               dev.battery > 50 ? 'fa-battery-three-quarters' :
                               dev.battery > 25 ? 'fa-battery-half' :
                               dev.battery > 10 ? 'fa-battery-quarter' : 'fa-battery-empty';

            html += `
                <div class="device-card ${isActive ? 'active' : ''}" onclick="selectDevice('${id}')">
                    <div class="device-header">
                        <div class="device-avatar" style="background:linear-gradient(135deg,#FF6B9D,#E84580);">${dev.emoji}</div>
                        <div>
                            <div class="device-name">${dev.name}</div>
                            <div class="device-label">${dev.online ? '在线' : '离线'}</div>
                        </div>
                        <span class="device-status-badge ${dev.online ? 'badge-online' : 'badge-offline'}">
                            ${dev.online ? '在线' : '离线'}
                        </span>
                    </div>

                    <div class="battery-section">
                        <div class="battery-label">
                            <i class="fas ${batteryIcon}"></i> 电量 ${chargingIcon}
                        </div>
                        <div class="battery-bar-container">
                            <div class="battery-bar">
                                <div class="battery-bar-fill ${batteryClass}" style="width:${dev.battery}%;"></div>
                            </div>
                            <div class="battery-percent ${batteryClass}">${dev.battery}%</div>
                        </div>
                    </div>

                    <div class="device-info-grid">
                        <div class="info-item">
                            <div class="info-item-label"><i class="fas fa-location-dot"></i> 位置</div>
                            <div class="info-item-value" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${dev.address || '获取中...'}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-item-label"><i class="fas fa-clock"></i> 更新</div>
                            <div class="info-item-value">${formatTime(dev.lastUpdate)}</div>
                        </div>
                    </div>
                </div>
            `;
        });
    }

    sidebar.innerHTML = html;
}

// ---- 选择设备 ----
function selectDevice(deviceId) {
    activeDeviceId = deviceId;
    centerOnDevice();
    renderSidebar();
    const dev = devices[deviceId];
    if (dev) updateBottomInfo(dev);
}

// ---- 更新底部信息 ----
function updateBottomInfo(dev) {
    if (!dev) return;
    document.getElementById('infoAddress').textContent = dev.address || '获取中...';
    document.getElementById('infoTime').textContent = formatTime(dev.lastUpdate);
    document.getElementById('infoBattery').textContent = dev.battery + '%';
}

// ============================================================
// 历史轨迹
// ============================================================
function toggleHistory() {
    isHistoryOpen = !isHistoryOpen;
    const panel = document.getElementById('historyPanel');
    const btn = document.getElementById('historyBtn');
    const bottomInfo = document.getElementById('bottomInfo');

    if (isHistoryOpen) {
        panel.classList.add('open');
        btn.classList.add('active');
        bottomInfo.classList.add('hidden');
        renderHistoryTimeline();
    } else {
        panel.classList.remove('open');
        btn.classList.remove('active');
        bottomInfo.classList.remove('hidden');
        clearHistoryMap();
        stopPlay();
    }
}

function renderHistoryTimeline() {
    const dev = devices[activeDeviceId];
    if (!dev) return;

    const timeline = document.getElementById('historyTimeline');
    const dateInput = document.getElementById('historyDate');
    dateInput.value = new Date().toISOString().split('T')[0];

    const history = deviceHistory[activeDeviceId] || [];
    if (history.length === 0) {
        timeline.innerHTML = '<div style="text-align:center;padding:30px;color:#8D6E63;">🐷 暂无轨迹数据<br><span style="font-size:12px;">等待小猪移动中...</span></div>';
        return;
    }

    let html = '';
    history.slice(-30).forEach((point, index) => {
        const time = new Date(point.time);
        html += `
            <div class="timeline-item" onclick="flyToHistoryPoint(${index})">
                <div class="timeline-dot" style="background:linear-gradient(135deg,#FF6B9D,#E84580);"></div>
                <div>
                    <div class="timeline-time">${formatTime(time)} · 电量 ${point.battery}%</div>
                    <div class="timeline-location">${point.address || '未知位置'}</div>
                </div>
            </div>
        `;
    });
    timeline.innerHTML = html;
}

function flyToHistoryPoint(index) {
    const history = deviceHistory[activeDeviceId] || [];
    const point = history[index];
    if (!point) return;
    if (AMapObj) {
        AMapObj.setZoomAndCenter(17, [point.lng, point.lat], false, 400);
    } else if (map) {
        map.flyTo([point.lat, point.lng], 17, { duration: 0.5 });
    }
}

function playHistory() {
    if (isPlaying) { stopPlay(); return; }

    const history = deviceHistory[activeDeviceId] || [];
    if (history.length < 2) { showToast('轨迹点太少，无法回放 🐷'); return; }

    isPlaying = true;
    document.getElementById('playBtn').innerHTML = '<i class="fas fa-pause"></i>';
    clearHistoryMap();

    // 绘制轨迹线
    const path = history.map(p => AMapObj ? [p.lng, p.lat] : [p.lat, p.lng]);

    if (AMapObj) {
        historyPolyline = new AMap.Polyline({
            path: path,
            strokeColor: '#FF6B9D',
            strokeWeight: 4,
            strokeOpacity: 0.7,
            strokeStyle: 'dashed',
            lineJoin: 'round'
        });
        historyPolyline.setMap(AMapObj);
    } else if (map) {
        historyPolyline = L.polyline(path, {
            color: '#FF6B9D',
            weight: 4,
            opacity: 0.7,
            dashArray: '10, 6'
        }).addTo(map);
    }

    let currentIndex = 0;
    const speed = parseInt(document.getElementById('speedSlider').value);

    if (AMapObj) {
        AMapObj.setZoomAndCenter(16, path[0], false, 500);
    } else if (map) {
        map.flyTo(path[0], 16, { duration: 0.5 });
    }

    playInterval = setInterval(() => {
        if (currentIndex >= history.length) {
            stopPlay();
            showToast('轨迹回放完成！🐷');
            return;
        }
        const point = history[currentIndex];

        if (AMapObj) {
            const circle = new AMap.CircleMarker({
                center: [point.lng, point.lat],
                radius: 6,
                fillColor: '#FF6B9D',
                fillOpacity: 1,
                strokeColor: 'white',
                strokeWeight: 2
            });
            circle.setMap(AMapObj);
            historyMarkers.push(circle);
            AMapObj.panTo([point.lng, point.lat], false, 300);
        } else if (map) {
            const circle = L.circleMarker([point.lat, point.lng], {
                radius: 6, fillColor: '#FF6B9D', fillOpacity: 1,
                color: 'white', weight: 2
            }).addTo(map);
            historyMarkers.push(circle);
            map.panTo([point.lat, point.lng], { duration: 0.3 });
        }

        // 高亮时间线
        const items = document.querySelectorAll('.timeline-item');
        items.forEach((item, i) => {
            item.classList.toggle('highlight', i === currentIndex);
        });

        currentIndex++;
    }, 1500 / speed);
}

function stopPlay() {
    isPlaying = false;
    document.getElementById('playBtn').innerHTML = '<i class="fas fa-play"></i>';
    if (playInterval) { clearInterval(playInterval); playInterval = null; }
}

function clearHistoryMap() {
    if (historyPolyline) {
        if (AMapObj) { historyPolyline.setMap(null); }
        else if (map) { map.removeLayer(historyPolyline); }
        historyPolyline = null;
    }
    historyMarkers.forEach(m => {
        if (AMapObj) { m.setMap(null); }
        else if (map) { map.removeLayer(m); }
    });
    historyMarkers = [];
}

// ============================================================
// 工具函数
// ============================================================
function formatTime(date) {
    if (!date) return '--:--';
    const d = new Date(date);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function updateHeaderTime() {
    const now = new Date();
    const options = { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    document.getElementById('headerTime').textContent = now.toLocaleString('zh-CN', options);
}

function showToast(message) {
    const toast = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function createFloatingHearts() {
    const container = document.getElementById('floatingHearts');
    const emojis = ['💕', '💗', '💖', '🌸', '✨', '🐷', '🎀'];
    for (let i = 0; i < 12; i++) {
        const heart = document.createElement('div');
        heart.className = 'heart';
        heart.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        heart.style.left = Math.random() * 100 + '%';
        heart.style.animationDelay = Math.random() * 15 + 's';
        heart.style.animationDuration = (12 + Math.random() * 10) + 's';
        heart.style.fontSize = (14 + Math.random() * 16) + 'px';
        container.appendChild(heart);
    }
}

// ---- 启动 ----
document.addEventListener('DOMContentLoaded', init);
