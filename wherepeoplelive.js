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

let initCenter = [-13, -49];
let initZoom = 3;
let radiusKm = 60;
let labelsMinZoom = 5;
let firstGuess;
let pointsPop;
let state;
let roundNumber;
let roundStart;

let messageCount = 0;
let countryBoundaries;

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
let dbFilesPromise = i18nPromise.then(() => Promise.all([
	fetch("boundaries.json"),
	fetch("countries.json"),
	fetch("cities5000.txt")
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
	for (let c = 0; c < order.length; c++) {
		let cityRow = cityRows[order[c]];
		let displayName = copyString(cityRow[1]);
		let city = turf.point([parseFloat(cityRow[5]), parseFloat(cityRow[4])]);
		city.properties.id = copyString(cityRow[0]);
		city.properties.pop = parseInt(cityRow[14], 10);
		city.properties.displayName = displayName;
		city.capital = cityRow[7] == "PPLC" && cityRow[9] == "";
		city.guessed = false;
		city.revealed = false;
		city.marked = false;
		city.circleLayer = null;
		city.radiusLayer = null;
		cities[c] = city;

		let names = [displayName].concat(copyString(cityRow[3]).split(","));
		for (let n = 0; n < names.length; n++) {
			addNameIndex(convertSearchName(names[n]), c);
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

	map.on('moveend zoomend', updateVisibleCities);

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
	toAdd.sort((a, b) => {
		if (a.capital !== b.capital) {
			return a.capital ? 1 : -1;
		}
		return a.properties.pop - b.properties.pop;
	});
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
			markCity(e.target.city, false, true);
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
		previousState = JSON.parse(previousState);
		previousState.guessed.forEach(previousCityId => {
			let citiesFound = cities.filter(city => city.properties.id == previousCityId);
			cityGuessed(citiesFound);
		});
		previousState.revealed.forEach(previousCityId => {
			let citiesFound = cities.filter(city => city.properties.id == previousCityId);
			citiesFound.forEach(city => markCity(city, false, true));
		});
	}
	
	firstGuess = true;
	searchFocus();
	showMessage(i18n("I8N_ENTER_CITY_NAME"));
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

	document.getElementById("search").value = "";
	let center = map.getCenter();
	let centerPoint = turf.point([center.lng, center.lat]);
	citiesGuessed.sort((b, a) => turf.distance(centerPoint, a) - turf.distance(centerPoint, b));
	hideMessage();
	cityGuessed(citiesGuessed);
}

function cityGuessed(citiesGuessed) {
	let city = citiesGuessed[0];
	track("guess", { city: city.properties.displayName, pop: city.properties.pop, capital: city.capital });
	map.flyTo([city.geometry.coordinates[1], city.geometry.coordinates[0]], (firstGuess ? 6 : map.getZoom()));
	if (firstGuess) {
		firstGuess = false;
	}

	map.once('moveend', function() {
		let nearbyCities = nearCities(city);
		nearbyCities.forEach(nearbyCity => markCity(nearbyCity, nearbyCity.properties.id==city.properties.id, false));

		citiesGuessed.shift();
		if (citiesGuessed.length>0) {
			cityGuessed(citiesGuessed);
		}
		document.getElementById("pointsPop").innerHTML = pointsPop.toLocaleString();
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
	return result;
}

function markCity(city, guessedNow, revealedNow) {
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
		if (!revealedNow) {
			pointsPop += city.properties.pop;
		}
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
