let map;
let citiesLayerGroup;
let cityGuessedLabelsLayerGroup;
let cityRevealedLabelsLayerGroup;
let countryBoundariesLayerGroup;
let countryLabelsLayerGroup;

let countries;
let cities;
let nameIndex;
let citiesRenderer;
let renderedCities;

let countryStats = new Map();
let currentLanguage = "en";
let countryDisplayNames = null;
let countryBarsUpdatePending = false;
let summaryBarsUpdatePending = false;
let medalQueue = [];
let totalWorldPopulation = 0;

function getCountryMedalLevel(stats) {
	if (!stats || !stats.totalPop || stats.totalPop <= 0) {
		return 0;
	}
	let percent = stats.markedPop / stats.totalPop;
	if (percent >= 0.9) return 3;
	if (percent >= 0.8) return 2;
	if (percent >= 0.7) return 1;
	return 0;
}

function updateCountryMedalLevel(stats) {
	if (!stats) {
		return 0;
	}
	stats.medalLevel = getCountryMedalLevel(stats);
	return stats.medalLevel;
}

let initCenter = [-13, -49];
let initZoom = 3;
let radiusKm = 60;
let labelsMinZoom = 5;
let firstGuess;
let pointsPop;
let state;
let roundNumber;
let roundStart;
let loadingSavedState = false;

let messageCount = 0;
let countryBoundaries;
let medalTriggerCountry = null;
let guessToken = 0;
let activeGuessToken = 0;
let activeGuessList = [];

// Inicia o download do repositório de traduções em segundo plano, enquanto a
// splash screen é exibida. Os textos traduzíveis começam vazios no HTML (via
// data-i18n) e só são preenchidos em applyI18n(), após definir o idioma.
let i18nStrings = {};
let i18nPromise = loadI18n();

// Inicia o download dos arquivos de dados em segundo plano, mas somente após o
// repositório de traduções já ter sido carregado. Registra o momento em que a
// barra de progresso passa a ser exibida, para garantir o tempo mínimo de
// exibição.
let splashStartTime = Date.now();
// Em localhost nenhum servidor envia Content-Encoding: br, então baixa o
// arquivo original; em produção (S3) baixa a versão brotli, que o browser
// descompacta transparentemente.
let citiesFile = location.hostname.includes("localhost") ? "cities5000.txt" : "cities5000.txt.br";
let dbFilesPromise = i18nPromise.then(() => Promise.all([
	fetch("boundaries.json"),
	fetch("countries.json"),
	fetch(citiesFile)
]));

async function loadI18n() {
	try {
		let response = await fetch("i8n.json");
		let translations = await response.json();
		// navigator.language devolve algo como "pt-BR"; usa apenas o código
		// base ("pt"), já que o repositório não varia por região.
		let browserLanguages = navigator.languages || [navigator.language || "en"];
		for (let browserLanguage of browserLanguages) {
			let base = browserLanguage.split("-")[0].toLowerCase();
			if (translations[base]) {
				i18nStrings = translations[base];
				currentLanguage = base;
				return;
			}
		}
		i18nStrings = translations["en"];
	}
	catch (error) {
		// Sem traduções disponíveis: os textos permanecem vazios.
		i18nStrings = {};
	}
}

function i18n(key) {
	return i18nStrings[key] || "";
}

function applyI18n() {
	document.querySelectorAll("[data-i18n]").forEach(element => {
		element.textContent = i18n(element.getAttribute("data-i18n"));
	});
}

async function init() {
	await i18nPromise;
	applyI18n();
	await processDB();
	initMap();
	document.addEventListener("keydown", event => {	searchFocus(); });
	document.addEventListener("visibilitychange", event => { searchFocus(); });
	// Mantém a barra de progresso exibida por alguns segundos, mesmo que
	// os arquivos já tenham sido baixados.
	let remainingTime = Math.max(0, 4000 - (Date.now() - splashStartTime));
	setTimeout(function() {
		document.getElementById("progressBar").style.display = "none";
		startGame();
	}, remainingTime);
}

function searchFocus() {
	if (document.activeElement.id != "search") {
		document.getElementById("search").focus();
	}
}

async function processDB() {
	let [boundariesResponse, countriesResponse, response] = await dbFilesPromise;
	countryBoundaries = await boundariesResponse.json();
	countries = await countriesResponse.json();
	let citiesText = new TextDecoder("utf-8").decode(await response.arrayBuffer());
	let cityRows = citiesText.split(/\r?\n/).filter(line => line.trim() != "").map(line => line.split("\t"));
	citiesText = null;

	// Ordena apenas os índices das linhas por população, em vez de ordenar os
	// objetos e guardar um dbIndex em cada um (o que forçava um "delete" e o
	// objeto a entrar em dictionary mode).
	let order = new Int32Array(cityRows.length);
	for (let i = 0; i < order.length; i++) {
		order[i] = i;
	}
	order.sort((a, b) => parseInt(cityRows[b][14], 10) - parseInt(cityRows[a][14], 10));

	nameIndex = new Map();
	cities = new Array(cityRows.length);
	countryStats = new Map();
	for (let c = 0; c < order.length; c++) {
		let cityRow = cityRows[order[c]];
		let displayName = copyString(cityRow[1]);
		let city = turf.point([parseFloat(cityRow[5]), parseFloat(cityRow[4])]);
		city.properties.id = copyString(cityRow[0]);
		city.properties.pop = parseInt(cityRow[14], 10);
		city.properties.displayName = displayName;
		let countryCodeController = cityRow[9];
		let countryCodeRaw = (countryCodeController == "" ? cityRow[8]: countryCodeController);
		let countryCode = String(countryCodeRaw || "").trim().substring(0, 2).toUpperCase();
		if (countryCode == "") {
			countryCode = String(countryCodeRaw || "").trim();
		}
		let stats = countryStats.get(countryCode);
		if (!stats) {
			stats = {
				code: countryCode,
				count: 0,
				totalPop: 0,
				markedPop: 0,
				medalLevel: 0,
				refLon: 0,
				minLat: 0,
				maxLat: 0,
				minLon: 0,
				maxLon: 0
			};
			countryStats.set(countryCode, stats);
		}
		city.properties.countryCode = stats.code;
		city.capital = cityRow[7] == "PPLC" && countryCodeController == "";
		city.guessed = false;
		city.revealed = false;
		city.marked = false;
		city.circleLayer = null;
		city.radiusLayer = null;
		cities[c] = city;

		// Total de população do país e bounding box de todas as suas cidades
		// (usado depois para saber se o país está visível no mapa).
		let lat = city.geometry.coordinates[1];
		let lon = city.geometry.coordinates[0];
		stats.totalPop += city.properties.pop;
		if (stats.count == 0) {
			stats.refLon = lon;
			stats.minLat = lat;
			stats.maxLat = lat;
			stats.minLon = lon;
			stats.maxLon = lon;
		}
		else {
			if (lat < stats.minLat) stats.minLat = lat;
			if (lat > stats.maxLat) stats.maxLat = lat;
			let normLon = stats.refLon + normalizeLongitude(lon - stats.refLon);
			if (normLon < stats.minLon) stats.minLon = normLon;
			if (normLon > stats.maxLon) stats.maxLon = normLon;
		}
		stats.count++;
		updateCountryMedalLevel(stats);
		let names = [displayName].concat(copyString(cityRow[3]).split(","));
		for (let n = 0; n < names.length; n++) {
			addNameIndex(convertSearchName(names[n]), c);
		}
	}
	// Soma de toda a população mundial e total de capitais
	totalWorldPopulation = 0;
	totalCapitalsCount = 0;
	countryStats.forEach(stats => {
		if (stats.totalPop) {
			totalWorldPopulation += stats.totalPop;
		}
	});
	if (cities) {
		for (let i = 0; i < cities.length; i++) {
			if (cities[i].capital) {
				totalCapitalsCount++;
			}
		}
	}
	cityRows.length = 0;
}

function copyString(str) {
	// O V8 representa substrings longas como "SlicedString", que mantém vivo o
	// buffer do arquivo inteiro (15 MB). Copia para uma string independente.
	return str.length >= 13 ? str.split("").join("") : str;
}

function addNameIndex(name, cityIndex) {
	if (name == "") {
		return;
	}
	let cityIndexes = nameIndex.get(name);
	if (cityIndexes === undefined) {
		// Guarda um número simples quando o nome aponta para uma única cidade
		// (a grande maioria), economizando um array por nome.
		nameIndex.set(name, cityIndex);
	}
	else if (typeof cityIndexes === "number") {
		if (cityIndexes != cityIndex) {
			nameIndex.set(name, [cityIndexes, cityIndex]);
		}
	}
	else if (cityIndexes[cityIndexes.length - 1] != cityIndex) {
		cityIndexes.push(cityIndex);
	}
}

function initMap() {
	map = L.map('map', {
		center: initCenter,
		zoom: initZoom,
		minZoom: 2,
		maxZoom: 7,
		worldCopyJump: true,
		attributionControl: false
	});

	L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
		attribution: '&copy; Esri, OpenStreetMap',
		opacity: 0.5
	}).addTo(map);
	
	cityGuessedLabelsLayerGroup = L.layerGroup();
	cityRevealedLabelsLayerGroup = L.layerGroup();

	countryBoundariesLayerGroup = L.layerGroup();
	L.geoJSON(countryBoundaries, { style: {"color": "lightgray", "weight": 2, "dashArray": "6 6", "dashOffset": "0", "fillColor": "none", "opacity": 0.8} }).addTo(countryBoundariesLayerGroup);
	L.geoJSON(countryBoundaries, { style: {"color": "darkgray", "weight": 2, "dashArray": "6 6", "dashOffset": "6", "fillColor": "none", "opacity": 0.8} }).addTo(countryBoundariesLayerGroup);

	countryLabelsLayerGroup = L.layerGroup();
	countries.forEach(country => L.tooltip([country.lat, country.lon], {content: country.name, permanent: true, direction: "center", className: "countryLabel"}).addTo(countryLabelsLayerGroup));

	citiesRenderer = L.canvas({ padding: 0.5 });
	renderedCities = new Set();
	citiesLayerGroup = L.layerGroup().addTo(map);

	map.on('moveend zoomend', function() {
		updateVisibleCities();
		scheduleCountryBarsUpdate();
		scheduleSummaryBarsUpdate();
	});

	map.on('zoomend', function() {
		if (map.getZoom() < labelsMinZoom) {
			document.getElementById("showGuessedLabels").disabled = true;
			map.removeLayer(cityGuessedLabelsLayerGroup);
			document.getElementById("showRevealedLabels").disabled = true;
			map.removeLayer(cityRevealedLabelsLayerGroup);
			document.getElementById("showCountryLabels").disabled = true;
			map.removeLayer(countryLabelsLayerGroup);
			document.getElementById("showCountryBoundaries").disabled = true;
			map.removeLayer(countryBoundariesLayerGroup);
		}
		else {
			document.getElementById("showGuessedLabels").disabled = false;
			showGuessedLabels();
			document.getElementById("showRevealedLabels").disabled = false;
			showRevealedLabels();
			document.getElementById("showCountryLabels").disabled = false;
			showCountryLabels();
			document.getElementById("showCountryBoundaries").disabled = false;
			showCountryBoundaries();
		}
	});
}

// Ordem de marcação: não capitais antes das capitais e, dentro de cada grupo,
// menor população primeiro. A renderização usa a mesma ordem para que as
// capitais fiquem por cima.
function compareMarkOrder(a, b) {
	if (a.capital !== b.capital) {
		return a.capital ? 1 : -1;
	}
	return a.properties.pop - b.properties.pop;
}

// Renderiza apenas as cidades visíveis na viewport, e somente a partir do zoom
// em que os círculos têm tamanho significativo.
function updateVisibleCities() {
	if (!cities || !map || !renderedCities) {
		return;
	}
	let bounds = map.getBounds().pad(0.2);
	let visible = new Set();
	let toAdd = [];
	for (let i = 0; i < cities.length; i++) {
		let city = cities[i];
		if (cityInBounds(city, bounds)) {
			visible.add(city);
			if (!city.circleLayer) {
				toAdd.push(city);
			}
		}
	}
	renderedCities.forEach(city => {
		if (!visible.has(city)) {
			citiesLayerGroup.removeLayer(city.circleLayer);
			city.circleLayer = null;
			renderedCities.delete(city);
		}
	});

	// Ordenação em dois níveis: primeiro as não capitais (menor população
	// primeiro) e, por cima, as capitais (também menor população primeiro).
	toAdd.sort(compareMarkOrder);
	for (let i = 0; i < toAdd.length; i++) {
		let city = toAdd[i];
		let circle = L.circle([city.geometry.coordinates[1], city.geometry.coordinates[0]], {
			renderer: citiesRenderer,
			weight: city.capital ? 2 : 0,
			color: "#5555FF",
			fillColor: cityColor(city),
			fillOpacity: 1,
			radius: Math.sqrt(city.properties.pop / 3.14159) * 15
		});
		circle.city = city;
		circle.on("click", function (e) {
			markCity(e.target.city, false, true, false);
		});
		city.circleLayer = circle;
		renderedCities.add(city);
		citiesLayerGroup.addLayer(circle);
	}
}

function cityInBounds(city, bounds) {
	let lat = city.geometry.coordinates[1];
	if (lat < bounds.getSouth() || lat > bounds.getNorth()) {
		return false;
	}
	let west = bounds.getWest();
	let east = bounds.getEast();
	if (east - west >= 360) {
		return true;
	}
	// Normaliza para lidar com a viewport virando o mundo (worldCopyJump).
	let lon = west + (((city.geometry.coordinates[0] - west) % 360) + 360) % 360;
	return lon <= east;
}


// Normaliza um deslocamento de longitude para o intervalo [-180, 180).
function normalizeLongitude(delta) {
	let d = delta % 360;
	if (d < -180) {
		d += 360;
	}
	else if (d > 180) {
		d -= 360;
	}
	return d;
}

// Nome do país a partir do código de duas letras, no idioma da interface.
function countryDisplayName(code) {
	let translated = i18n("I8N_COUNTRY_" + code);
	if (translated) {
		return translated;
	}
	if (!countryDisplayNames) {
		try {
			countryDisplayNames = new Intl.DisplayNames([currentLanguage], {type: "region"});
		}
		catch (error) {
			countryDisplayNames = false;
		}
	}
	if (countryDisplayNames) {
		try {
			let name = countryDisplayNames.of(code);
			if (name && name != code) {
				return name;
			}
		}
		catch (error) {
		}
	}
	return code;
}

// Um país está visível se o seu bounding box (de todas as suas cidades)
// intersecta a viewport atual.
function countryVisible(stats, bounds) {
	let south = bounds.getSouth();
	let north = bounds.getNorth();
	if (stats.maxLat < south || stats.minLat > north) {
		return false;
	}
	let west = bounds.getWest();
	let east = bounds.getEast();
	if (east - west >= 360) {
		return true;
	}
	let center = (stats.minLon + stats.maxLon) / 2;
	let shift = Math.round(((west + east) / 2 - center) / 360) * 360;
	let minLon = stats.minLon + shift;
	let maxLon = stats.maxLon + shift;
	return maxLon >= west && minLon <= east;
}

function scheduleCountryBarsUpdate() {
	if (countryBarsUpdatePending) {
		return;
	}
	countryBarsUpdatePending = true;
	requestAnimationFrame(function() {
		countryBarsUpdatePending = false;
		updateCountryBars();
	});
}

// Barras de conquista por país: mostra os 5 países visíveis no mapa com a
// maior porcentagem da população já descoberta.
function updateCountryBars() {
	let container = document.getElementById("countryBars");
	if (!container || !cities || !map || countryStats.size == 0) {
		return;
	}
	let bounds = map.getBounds();
	let visible = [];
	countryStats.forEach(stats => {
		if (stats.markedPop <= 0 || stats.totalPop <= 0) {
			return;
		}
		if (!countryVisible(stats, bounds)) {
			return;
		}
		visible.push(stats);
	});
	visible.sort((a, b) => (b.markedPop / b.totalPop) - (a.markedPop / a.totalPop));
	visible = visible.slice(0, 5);

	container.innerHTML = "";
	let medalQueueCopy = medalQueue.slice();
	let medalTriggerIndex = 0;
	visible.forEach(stats => {
		updateCountryMedalLevel(stats);
		let percent = stats.markedPop / stats.totalPop;
		let row = document.createElement("div");
		row.className = "countryBar";
		row.title = countryDisplayName(stats.code) + ": " + (percent * 100).toFixed(2) + "% (" +
			stats.markedPop.toLocaleString() + " / " + stats.totalPop.toLocaleString() + ")";

		let fill = document.createElement("span");
		fill.className = "countryBarFill";
		// Cor: vermelho em 0%, amarelo em 50%, verde em 100%.
		let p = Math.max(0, Math.min(1, percent));
		let r, g, b;
		if (p <= 0.5) {
			let t = p / 0.5;
			r = Math.round(220 * (1 - t) + 255 * t);
			g = Math.round(50 * (1 - t) + 215 * t);
			b = Math.round(50 * (1 - t) + 0 * t);
		} else {
			let t = (p - 0.5) / 0.5;
			r = Math.round(255 * (1 - t) + 40 * t);
			g = Math.round(215 * (1 - t) + 170 * t);
			b = Math.round(0 * (1 - t) + 40 * t);
		}
		let color = "rgb(" + r + ", " + g + ", " + b + ")";
		fill.setAttribute("style", "width:" + Math.max(1, percent * 70).toFixed(2) + "px; background-image:none; background-color:" + color + ";");

		// Medalha: bronze >=70%, prata >=80%, ouro >=90%.
		let medalLevel = stats.medalLevel !== undefined ? stats.medalLevel : getCountryMedalLevel(stats);
		stats.medalLevel = medalLevel;
		if (medalLevel > 0) {
			let medal = document.createElement("span");
			medal.className = "countryMedal medal" + medalLevel;
			if (medalLevel == 1) medal.textContent = "\ud83e\udd49";
			else if (medalLevel == 2) medal.textContent = "\ud83e\udd48";
			else medal.textContent = "\ud83e\udd47";
			row.appendChild(medal);
			let inQueue = false;
			for (let q = 0; q < medalQueueCopy.length; q++) {
				if (medalQueueCopy[q] == stats.code) {
					inQueue = true;
					break;
				}
			}
			if (stats._lastMedalLevel !== medalLevel && !loadingSavedState && inQueue) {
				let delay = medalTriggerIndex * 1000;
				medalTriggerIndex++;
				setTimeout(function() {
					triggerMedalAnimation(row, medalLevel);
					playMedalSound(medalLevel);
				}, delay);
				stats._lastMedalLevel = medalLevel;
			} else if (stats._lastMedalLevel !== medalLevel) {
				stats._lastMedalLevel = medalLevel;
			}
		}
		else {
			if (!loadingSavedState) {
				stats._lastMedalLevel = 0;
			} else if (stats._lastMedalLevel === undefined) {
				stats._lastMedalLevel = 0;
			}
		}

		row.appendChild(fill);

		let value = document.createElement("span");
		value.className = "countryBarPercent";
		value.textContent = (percent * 100).toFixed(1) + "%";
		row.appendChild(value);

		let label = document.createElement("span");
		label.className = "countryBarName";
		label.textContent = countryDisplayName(stats.code);
		row.appendChild(label);

		container.appendChild(row);
	});
	if (medalTriggerIndex > 0) {
		medalQueue = [];
	}
	medalTriggerCountry = null;
}

function scheduleSummaryBarsUpdate() {
	if (summaryBarsUpdatePending) {
		return;
	}
	summaryBarsUpdatePending = true;
	requestAnimationFrame(function() {
		summaryBarsUpdatePending = false;
		updateSummaryBars();
	});
}

let totalCapitalsCount = 0;

function updateSummaryBars() {
	let container = document.getElementById("summaryBars");
	if (!container) {
		return;
	}
	container.innerHTML = "";

	if (!countryStats) {
		return;
	}

	let gold = 0;
	let silver = 0;
	let bronze = 0;
	let capitalsGuessedCount = 0;
	countryStats.forEach(stats => {
		let level = stats.medalLevel !== undefined ? stats.medalLevel : getCountryMedalLevel(stats);
		stats.medalLevel = level;
		if (level == 1) {
			bronze++;
		} else if (level == 2) {
			silver++;
		} else if (level == 3) {
			gold++;
		}
	});

	if (cities) {
		for (let i = 0; i < cities.length; i++) {
			if (cities[i].capital && cities[i].guessed) {
				capitalsGuessedCount++;
			}
		}
	}

	// Ouro
	let goldRow = document.createElement("div");
	goldRow.className = "summaryBar";
	let goldIcon = document.createElement("span");
	goldIcon.className = "summaryBarIcon";
	goldIcon.textContent = "\ud83e\udd47";
	goldRow.appendChild(goldIcon);
	let goldVal = document.createElement("span");
	goldVal.textContent = gold.toString();
	goldRow.appendChild(goldVal);
	container.appendChild(goldRow);

	// Prata
	let silverRow = document.createElement("div");
	silverRow.className = "summaryBar";
	let silverIcon = document.createElement("span");
	silverIcon.className = "summaryBarIcon";
	silverIcon.textContent = "\ud83e\udd48";
	silverRow.appendChild(silverIcon);
	let silverVal = document.createElement("span");
	silverVal.textContent = silver.toString();
	silverRow.appendChild(silverVal);
	container.appendChild(silverRow);

	// Bronze
	let bronzeRow = document.createElement("div");
	bronzeRow.className = "summaryBar";
	let bronzeIcon = document.createElement("span");
	bronzeIcon.className = "summaryBarIcon";
	bronzeIcon.textContent = "\ud83e\udd49";
	bronzeRow.appendChild(bronzeIcon);
	let bronzeVal = document.createElement("span");
	bronzeVal.textContent = bronze.toString();
	bronzeRow.appendChild(bronzeVal);
	container.appendChild(bronzeRow);

	// Capitais (porcentagem)
	let capRow = document.createElement("div");
	capRow.className = "summaryBar";
	let capIcon = document.createElement("span");
	capIcon.className = "capitalIcon";
	capRow.appendChild(capIcon);
	let capPct = 0;
	if (totalCapitalsCount > 0) {
		capPct = (capitalsGuessedCount / totalCapitalsCount) * 100;
	}
	let capVal = document.createElement("span");
	capVal.textContent = capPct.toFixed(2) + "%";
	capRow.appendChild(capVal);
	container.appendChild(capRow);

	// Porcentagem da população mundial
	let worldPctRow = document.createElement("div");
	worldPctRow.className = "summaryBar";
	let globeIcon = document.createElement("span");
	globeIcon.className = "summaryBarIcon globe";
	globeIcon.textContent = "\ud83c\udf0d";
	worldPctRow.appendChild(globeIcon);
	let pct = 0;
	if (totalWorldPopulation > 0) {
		pct = (pointsPop / totalWorldPopulation) * 100;
	}
	let pctVal = document.createElement("span");
	pctVal.textContent = pct.toFixed(2) + "%";
	worldPctRow.appendChild(pctVal);
	container.appendChild(worldPctRow);
}
// Som triplo crescente para novas medalhas.
function playMedalSound(level) {
	try {
		let AudioCtx = window.AudioContext || window.webkitAudioContext;
		if (!AudioCtx) return;
		let ctx = new AudioCtx();
		let base = level == 1 ? 520 : (level == 2 ? 660 : 880);
		[0, 0.12, 0.24].forEach((d, i) => {
			let o = ctx.createOscillator();
			let g = ctx.createGain();
			o.frequency.value = base * (1 + i * 0.25);
			o.type = "triangle";
			o.connect(g); g.connect(ctx.destination);
			g.gain.setValueAtTime(0, ctx.currentTime + d);
			g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + d + 0.01);
			g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.18);
			o.start(ctx.currentTime + d);
			o.stop(ctx.currentTime + d + 0.2);
		});
	} catch (e) {}
}
// Animação de medalha: aparece grande no centro e vai para a barra.
function triggerMedalAnimation(targetRow, level) {
	let center = document.createElement("div");
	if (level == 1) center.textContent = "\ud83e\udd49";
	else if (level == 2) center.textContent = "\ud83e\udd48";
	else center.textContent = "\ud83e\udd47";
	center.style.position = "fixed";
	center.style.left = "50%";
	center.style.top = "50%";
	center.style.transform = "translate(-50%, -50%) scale(3)";
	center.style.fontSize = "80px";
	center.style.zIndex = "1000";
	center.style.transition = "all 0.6s ease-in";
	center.style.pointerEvents = "none";
	document.body.appendChild(center);
	setTimeout(function() {
		let rect = targetRow.getBoundingClientRect();
		center.style.left = rect.left + 8 + "px";
		center.style.top = rect.top + rect.height / 2 + "px";
		center.style.transform = "translate(-50%, -50%) scale(0.7)";
	}, 20);
	setTimeout(function() {
		center.remove();
	}, 700);
}

function cityColor(city) {
	if (city.revealed) {
		return "#dbb81e";
	}
	if (city.guessed || city.marked) {
		return "#2d7d2d";
	}
	return "#ff2222";
}

function refreshCityColor(city) {
	if (city.circleLayer) {
		city.circleLayer.setStyle({ fillColor: cityColor(city) });
	}
}

// Rastreamento de uso via Umami Cloud (analytics sem cookies, IP anonimizado).
// Se o script não carregar (bloqueador de anúncios, offline), o jogo segue
// normalmente — analytics nunca deve quebrar o jogo.
function track(name, data) {
	if (window.umami) {
		umami.track(name, data);
	}
}

// --- Efeito de conquista ao descobrir uma capital --------------------------
// O som é gerado via Web Audio (nada de arquivo de áudio no repositório) e a
// política de autoplay do browser só liberta o áudio após um gesto do
// utilizador: cria/desbloqueia o contexto no primeiro keydown/pointerdown.
let audioContext;

function unlockAudio() {
	ensureAudioContext();
	document.removeEventListener("keydown", unlockAudio);
	document.removeEventListener("pointerdown", unlockAudio);
}

function ensureAudioContext() {
	let AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass) {
		return null;
	}
	if (!audioContext) {
		audioContext = new AudioContextClass();
	}
	if (audioContext.state == "suspended") {
		audioContext.resume();
	}
	return audioContext;
}

document.addEventListener("keydown", unlockAudio);
document.addEventListener("pointerdown", unlockAudio);

function playCapitalSound() {
	let context = ensureAudioContext();
	if (!context) {
		return;
	}
	// Dois tons crescentes: quinta justa ascendente (C5 → G5), sensação
	// positiva de conquista. Cada tom sobe rápido e decai devagar; a segunda
	// nota termina ~2s após o início.
	let notes = [523.25, 783.99];
	let startTime = context.currentTime;
	notes.forEach((frequency, i) => {
		let noteStart = startTime + i * 0.35;
		let oscillator = context.createOscillator();
		let gain = context.createGain();
		oscillator.type = "triangle";
		oscillator.frequency.setValueAtTime(frequency, noteStart);
		gain.gain.setValueAtTime(0.0001, noteStart);
		gain.gain.exponentialRampToValueAtTime(0.2, noteStart + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 1.6);
		oscillator.connect(gain);
		gain.connect(context.destination);
		oscillator.start(noteStart);
		oscillator.stop(noteStart + 1.65);
	});
}

function celebrateCapital() {
	playCapitalSound();
	// Remove e recoloca a classe forçando um reflow para reiniciar a
	// animação — assim disparos seguidos (várias capitais) reacendem o brilho.
	let glow = document.getElementById("capitalGlow");
	glow.classList.remove("active");
	void glow.offsetWidth;
	glow.classList.add("active");
}

function startGame() {
	// A splash é ocultada aqui (após o tempo mínimo de exibição / download).
	// A partir daí ela passa a ficar reduzida: título 40% + descrição, visível
	// apenas quando o usuário clicar em "?" para reexibi-la.
	document.getElementById("splash").classList.add("reduced");
	document.getElementById("splash").style.display = "none";
	cityGuessedLabelsLayerGroup.clearLayers();
	cityRevealedLabelsLayerGroup.clearLayers();

	document.getElementById("search").value = "";
	document.getElementById("pointsPop").innerHTML = "0";
	pointsPop = 0;
	state = { guessed : [], revealed : [] };
	scheduleSummaryBarsUpdate();

	// Uma "rodada" vai do primeiro carregamento (ou do reinício) até o próximo
	// reinício. Guardada em localStorage para sobreviver a reloads no meio da
	// partida — startGame() também roda ao recarregar a página.
	roundNumber = parseInt(localStorage.getItem("roundNumber") || "0", 10);
	roundStart = parseInt(localStorage.getItem("roundStart") || "0", 10);
	if (!roundStart) {
		roundNumber++;
		roundStart = Date.now();
		localStorage.setItem("roundNumber", roundNumber);
		localStorage.setItem("roundStart", roundStart);
	}
	track("game_start", { round: roundNumber });

	countryStats.forEach(stats => {
		stats.markedPop = 0;
		updateCountryMedalLevel(stats);
		if (!loadingSavedState) {
			stats._lastMedalLevel = undefined;
		}
	});
	cities.forEach(city => {
		if (city.radiusLayer) {
			map.removeLayer(city.radiusLayer);
			city.radiusLayer = null;
		}
		city.guessed = false;
		city.revealed = false;
		city.marked = false;
		refreshCityColor(city); // senão os círculos já renderizados mantêm a cor da partida anterior
	});
	map.setView(initCenter, initZoom);
	
	let previousState = localStorage.getItem("state");
	if (previousState) {
		loadingSavedState = true;
		previousState = JSON.parse(previousState);
		previousState.guessed.forEach(previousCityId => {
			let citiesFound = cities.filter(city => city.properties.id == previousCityId);
			cityGuessed(citiesFound, false);
		});
		previousState.revealed.forEach(previousCityId => {
			let citiesFound = cities.filter(city => city.properties.id == previousCityId);
			citiesFound.forEach(city => markCity(city, false, true, false));
		});
		loadingSavedState = false;
	}
	
	firstGuess = true;
	searchFocus();
	showMessage(i18n("I8N_ENTER_CITY_NAME"));
	scheduleSummaryBarsUpdate();
}

function showSplash() {
	document.getElementById("splash").style.display = "flex";
}

function closeSplash() {
	document.getElementById("splash").style.display = "none";
	searchFocus();
}

function searchName() {
	if(!(event.key === 'Enter')) {
        return;
    }
	let name = document.getElementById("search").value;
	if(name.trim() == "") {
		if (activeGuessList.length > 0) {
			let tokenEmpty = ++guessToken;
			activeGuessToken = tokenEmpty;
			for (let i = 0; i < activeGuessList.length; i++) {
				let prevCity = activeGuessList[i];
				let nearbyCities = nearCities(prevCity);
				for (let n = 0; n < nearbyCities.length; n++) {
					let nearbyCity = nearbyCities[n];
					let guessedNowPrev = nearbyCity.properties.id == prevCity.properties.id;
					markCity(nearbyCity, guessedNowPrev, false, true);
				}
			}
			if (activeGuessList.length > 0) {
				let lastCity = activeGuessList[activeGuessList.length - 1];
				map.setView([lastCity.geometry.coordinates[1], lastCity.geometry.coordinates[0]], Math.max(6, map.getZoom()), {animate: false});
			}
			activeGuessList = [];
			document.getElementById("pointsPop").innerHTML = pointsPop.toLocaleString();
		}
        return;
    }

	name = convertSearchName(name);
	let cityIndexes = nameIndex.get(name);
	if (cityIndexes === undefined) {
		track("guess_not_found", { term: name.slice(0, 40) });
		showMessage(i18n("I8N_CITY_NOT_FOUND"), 3000);
		return;
	}
	let indexes = typeof cityIndexes === "number" ? [cityIndexes] : cityIndexes;

	let citiesGuessed = [];
	indexes.forEach(cityIndex => {
		let city = cities[cityIndex];
		if (!city.guessed && !city.revealed) {
			citiesGuessed.push(city);
		}
	});

	if (citiesGuessed.length == 0) {
		let revealed = indexes.some(cityIndex => cities[cityIndex].revealed);
		track("guess_repeated", { revealed: revealed });
		showMessage(i18n(revealed ? "I8N_CITY_ALREADY_REVEALED" : "I8N_CITY_ALREADY_GUESSED"), 3000);
		return;
	}

	let token = ++guessToken;
	if (activeGuessList.length > 0 && activeGuessToken != token) {
		for (let i = 0; i < activeGuessList.length; i++) {
			let prevCity = activeGuessList[i];
			let nearbyCities = nearCities(prevCity);
			for (let n = 0; n < nearbyCities.length; n++) {
				let nearbyCity = nearbyCities[n];
				let guessedNowPrev = nearbyCity.properties.id == prevCity.properties.id;
				markCity(nearbyCity, guessedNowPrev, false, true);
			}
		}
		activeGuessList = [];
	}
	// Ordem de marcação (não de renderização): não capitais antes das capitais
	// e, dentro de cada grupo, menor população primeiro.
	citiesGuessed.sort(compareMarkOrder);
	if (citiesGuessed.length > 0) {
		let lastCity = citiesGuessed[citiesGuessed.length - 1];
		map.setView([lastCity.geometry.coordinates[1], lastCity.geometry.coordinates[0]], Math.max(6, map.getZoom()), {animate: false});
	}

	document.getElementById("search").value = "";
	hideMessage();
	activeGuessToken = token;
	activeGuessList = citiesGuessed.slice();
	cityGuessed(citiesGuessed.slice(), true, token);
}

function cityGuessed(citiesGuessed, fromUserInput, token) {
	if (fromUserInput && token !== undefined && token !== activeGuessToken) {
		activeGuessList = [];
		return;
	}
	let city = citiesGuessed[0];
	if (fromUserInput) {
		medalQueue = [];
	}
	track("guess", { city: city.properties.displayName, pop: city.properties.pop, capital: city.capital });
	if (fromUserInput && token !== undefined && token !== activeGuessToken) {
		activeGuessList = [];
		return;
	}
	map.flyTo([city.geometry.coordinates[1], city.geometry.coordinates[0]], Math.max(6, map.getZoom()));
	if (firstGuess) {
		firstGuess = false;
	}

	map.once('moveend', function() {
		if (fromUserInput && token !== undefined && token !== activeGuessToken) {
			activeGuessList = [];
			return;
		}
		let nearbyCities = nearCities(city);
		nearbyCities.forEach(nearbyCity => {
			let guessedNow = nearbyCity.properties.id == city.properties.id;
			markCity(nearbyCity, guessedNow, false, fromUserInput);
			// Conquista só quando o jogador digitou o nome (fromUserInput);
			// a restauração do estado anterior também entra por aqui e não
			// deve tocar som nem acender a borda.
			if (guessedNow && fromUserInput && nearbyCity.capital) {
				celebrateCapital();
			}
		});

		citiesGuessed.shift();
		if (activeGuessList.length > 0) {
			for (let a = 0; a < activeGuessList.length; a++) {
				if (activeGuessList[a] === city) {
					activeGuessList.splice(a, 1);
					break;
				}
			}
		}
		if (citiesGuessed.length>0) {
			if (fromUserInput && token !== undefined && token !== activeGuessToken) {
				activeGuessList = [];
				return;
			}
			cityGuessed(citiesGuessed, fromUserInput, token);
		} else {
			if (fromUserInput && token !== undefined && token === activeGuessToken) {
				activeGuessList = [];
			}
		}
		document.getElementById("pointsPop").innerHTML = pointsPop.toLocaleString();
		scheduleSummaryBarsUpdate();
	});
}

// Pré-filtro por caixa delimitadora antes da distância de grande círculo: em
// vez de ~70 mil chamadas de turf.distance a cada acerto, só as cidades dentro
// da caixa passam pela checagem verdadeira (que continua decidindo o resultado).
function nearCities(city) {
	let lat = city.geometry.coordinates[1];
	let lon = city.geometry.coordinates[0];
	let cos = Math.max(Math.cos(lat * Math.PI / 180), 1e-6);
	let dLat = (radiusKm / 110.57) * 1.02;   // margem de segurança: caixa nunca pode ficar menor que o círculo
	let dLon = (radiusKm / (111.32 * cos)) * 1.02;
	let south = lat - dLat;
	let north = lat + dLat;
	let west = lon - dLon;
	let east = lon + dLon;
	let result = [];
	for (let i = 0; i < cities.length; i++) {
		let city2 = cities[i];
		let lat2 = city2.geometry.coordinates[1];
		if (lat2 < south || lat2 > north) {
			continue;
		}
		let lon2 = city2.geometry.coordinates[0];
		if (lon2 < west) {
			lon2 += 360; // cidades cruzando o meridiano 180
		}
		else if (lon2 > east) {
			lon2 -= 360;
		}
		if (lon2 < west || lon2 > east) {
			continue;
		}
		if (turf.distance(city, city2) <= radiusKm) {
			result.push(city2);
		}
	}
	// A marcação dos arredores segue a mesma ordem usada para as cidades
	// digitadas: não capitais antes das capitais e menor população primeiro.
	result.sort(compareMarkOrder);
	return result;
}

function markCity(city, guessedNow, revealedNow, fromUserInput) {
	if (guessedNow) {
		city.guessed = true;
		let tooltip = L.tooltip([city.geometry.coordinates[1], city.geometry.coordinates[0]], {content: city.properties.displayName, permanent: true, direction: "right", className: "cityToolTipGuessed" });
		tooltip.addTo(cityGuessedLabelsLayerGroup);
		cityRadius(city);
		state.guessed.push(city.properties.id);
		saveState();
	}
	if (revealedNow && !city.guessed && !city.revealed) {
		city.revealed = true;
		if (!document.getElementById("showRevealedLabels").checked) {
			document.getElementById("showRevealedLabels").checked = true;
			showRevealedLabels();
		}
		let tooltip = L.tooltip([city.geometry.coordinates[1], city.geometry.coordinates[0]], {content: city.properties.displayName, permanent: true, direction: "right", className: "cityToolTipRevealed" });
		tooltip.addTo(cityRevealedLabelsLayerGroup);
		state.revealed.push(city.properties.id);
		saveState();
	}

	if (!city.marked) {
		city.marked = true;
		let stats = countryStats.get(city.properties.countryCode);
		if (stats && !revealedNow) {
			stats.markedPop += city.properties.pop;
			updateCountryMedalLevel(stats);
		}
		if (!revealedNow) {
			pointsPop += city.properties.pop;
		}
		if (fromUserInput && !revealedNow && stats) {
			let alreadyInQueue = false;
			for (let q = 0; q < medalQueue.length; q++) {
				if (medalQueue[q] == stats.code) {
					alreadyInQueue = true;
					break;
				}
			}
			if (!alreadyInQueue) {
				medalQueue.push(stats.code);
			}
		}
		if (guessedNow && fromUserInput && stats) {
			medalTriggerCountry = stats.code;
		}
		if (!loadingSavedState) {
			scheduleCountryBarsUpdate();
		} else {
			updateCountryBars();
		}
		scheduleSummaryBarsUpdate();
	}
	refreshCityColor(city);
}

function cityRadius(city) {
	if (!city.radiusLayer) {
		let circle = L.circle([city.geometry.coordinates[1], city.geometry.coordinates[0]], {
			fillColor: "green",
			fillOpacity: 0.4,
			weight: 0,
			radius: radiusKm * 1000
		});
		circle.addTo(map);
		city.radiusLayer = circle;
	}
	if (city.radiusLayer.options.fillOpacity > 0) {
		city.radiusLayer.setStyle({fillOpacity: city.radiusLayer.options.fillOpacity - 0.002});
		setTimeout(function () { cityRadius(city) }, 50);
	}
	else {
		map.removeLayer(city.radiusLayer);
		city.radiusLayer = null;
	}
}

// Aglutina as gravações: um acerto marca dezenas de cidades e cada uma
// chamaria JSON.stringify + localStorage.setItem. Um único save por "lote".
let saveStateTimer = null;

function saveState() {
	if (saveStateTimer) {
		return;
	}
	saveStateTimer = setTimeout(function () {
		saveStateTimer = null;
		localStorage.setItem("state", JSON.stringify(state));
	}, 100);
}

function restartGame() {
	if(confirm(i18n("I8N_RESTART_CONFIRM"))) {
		// O reinício é o fim natural de uma rodada (o jogo não tem tela de
		// game over): registra o resumo antes de zerar o estado.
		track("round_end", {
			round: roundNumber,
			guessed: state.guessed.length,
			revealed: state.revealed.length,
			points: pointsPop,
			seconds: Math.round((Date.now() - roundStart) / 1000)
		});
		if (saveStateTimer) {
			clearTimeout(saveStateTimer);
			saveStateTimer = null;
		}
		localStorage.removeItem("state");
		localStorage.removeItem("roundStart");
		startGame();
	}
}

function showMessage(text, delay) {
	messageCount++;
	let messageId = messageCount;
	document.getElementById("message").innerHTML = text;
	document.getElementById("message").style.display = "block";
	if (delay) {
		setTimeout(function() {
			if (messageId == messageCount) {
				document.getElementById("message").style.display = "none";
			}
		}, delay);
	}
}

function hideMessage() {
	document.getElementById("message").style.display = "none";
}

function showGuessedLabels() {
	if (document.getElementById("showGuessedLabels").checked) {
		map.addLayer(cityGuessedLabelsLayerGroup);
	}
	else {
		map.removeLayer(cityGuessedLabelsLayerGroup);
	}
}

function showRevealedLabels() {
	if (document.getElementById("showRevealedLabels").checked) {
		map.addLayer(cityRevealedLabelsLayerGroup);
	}
	else {
		map.removeLayer(cityRevealedLabelsLayerGroup);
	}
}

function showCountryLabels() {
	if (document.getElementById("showCountryLabels").checked) {
		map.addLayer(countryLabelsLayerGroup);
	}
	else {
		map.removeLayer(countryLabelsLayerGroup);
	}
}

function showCountryBoundaries() {
	if (document.getElementById("showCountryBoundaries").checked) {
		map.addLayer(countryBoundariesLayerGroup);
	}
	else {
		map.removeLayer(countryBoundariesLayerGroup);
	}
}

function convertSearchName(name) {
	return name.replace(/[ '"-.]/g, '').normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
