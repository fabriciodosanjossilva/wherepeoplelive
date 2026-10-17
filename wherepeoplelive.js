let map;
let citiesLayerGroup;
let cityGuessedLabelsLayerGroup;
let cityRevealedLabelsLayerGroup;
let countryBoundariesLayerGroup;
let countryLabelsLayerGroup;

let countryLabels;
let cities;
let nameIndex;
let citiesRenderer;
let renderedCities;

let initBounds = [[-30, 134], [56, -114]];
let radiusKm = 60;
let circlesMinZoom = 5;
let firstGuess;
let pointsPop;
let state;

let messageCount = 0;
let countryBoundaries;

async function init() {
	await processDB();
	initMap();
	document.addEventListener("keydown", event => {	searchFocus(); });
	document.addEventListener("visibilitychange", event => { searchFocus(); });
	setTimeout(startGame, 2000);
}

function searchFocus() {
	if (document.activeElement.id != "search") {
		document.getElementById("search").focus();
	}
}

async function processDB() {
	countryLabels = countriesDB.map(countryDB => {
		return { lat: countryDB.lat, lon: countryDB.lon, displayName: (countryDB.name_pt!="" ? countryDB.name_pt : (countryDB.name_en!="" ? countryDB.name_en : countryDB.name)) };
	});

	// Carrega as duas bases em paralelo; o conteúdo de boundaries.json é
	// descartado após o JSON.parse (o script principal não retém mais ~250 KB).
	let [boundariesResponse, response] = await Promise.all([
		fetch("boundaries.json"),
		fetch("cities5000.txt")
	]);
	countryBoundaries = await boundariesResponse.json();
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
	// Libera as linhas (dezenas de MB) usadas apenas para montar a base.
	cityRows.length = 0;
	countriesDB = null;
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
		center: [0,0],
		zoom: 4,
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
	countryLabels.forEach(country => L.tooltip([country.lat, country.lon], {content: country.displayName, permanent: true, direction: "center", className: "countryLabel"}).addTo(countryLabelsLayerGroup));

	citiesRenderer = L.canvas({ padding: 0.5 });
	renderedCities = new Set();
	citiesLayerGroup = L.layerGroup().addTo(map);
	map.on('moveend zoomend', updateVisibleCities);

	map.on('zoomend', function() {
		if (map.getZoom() < circlesMinZoom) {
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
			showHideGuessedLabels();
			document.getElementById("showRevealedLabels").disabled = false;
			showHideRevealedLabels();
			document.getElementById("showCountryLabels").disabled = false;
			showHideCountryLabels();
			document.getElementById("showCountryBoundaries").disabled = false;
			showHideCountryBoundaries();
		}
	});
}

// Renderiza apenas as cidades visíveis na viewport, e somente a partir do zoom
// em que os círculos têm tamanho significativo. Evita manter ~70 mil camadas
// Leaflet (e seus elementos no DOM) na memória ao mesmo tempo.
function updateVisibleCities() {
	if (!cities || !map || !renderedCities) {
		return;
	}
	if (map.getZoom() < circlesMinZoom) {
		clearRenderedCities();
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
	// Adiciona das menores para as maiores, para manter as maiores por cima.
	for (let i = toAdd.length - 1; i >= 0; i--) {
		let city = toAdd[i];
		let circle = L.circle([city.geometry.coordinates[1], city.geometry.coordinates[0]], {
			renderer: citiesRenderer,
			weight: 0,
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

function clearRenderedCities() {
	if (renderedCities.size == 0) {
		return;
	}
	citiesLayerGroup.clearLayers();
	renderedCities.forEach(city => {
		city.circleLayer = null;
	});
	renderedCities.clear();
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
	if (city.guessed) {
		return "green";
	}
	if (city.revealed) {
		return "orange";
	}
	if (city.marked) {
		return "green";
	}
	return "#ff0000";
}

function refreshCityColor(city) {
	if (city.circleLayer) {
		city.circleLayer.setStyle({ fillColor: cityColor(city) });
	}
}

function startGame() {
	document.getElementById("splash").style.display = "none";
	cityGuessedLabelsLayerGroup.clearLayers();
	cityRevealedLabelsLayerGroup.clearLayers();

	document.getElementById("search").value = "";
	document.getElementById("pointsPop").innerHTML = "0";
	pointsPop = 0;
	state = { guessed : [], revealed : [] };

	// Reaproveita a base única (sem clonar ~70 mil objetos) e apenas reinicia
	// o estado do jogo.
	cities.forEach(city => {
		if (city.radiusLayer) {
			map.removeLayer(city.radiusLayer);
			city.radiusLayer = null;
		}
		city.guessed = false;
		city.revealed = false;
		city.marked = false;
	});
	clearRenderedCities();
	map.fitBounds(initBounds);
	
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
	showMessage("Digite um nome de cidade.");
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
		showMessage("Nome não encontrado.", 3000);
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
		showMessage(revealed ? "Cidade já revelada." : "Cidade já adivinhada.", 3000);
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
			showHideRevealedLabels();
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
	if(confirm("O jogo será reiniciado. Todos os nomes serão descartados. Deseja continuar?")) {
		if (saveStateTimer) {
			clearTimeout(saveStateTimer);
			saveStateTimer = null;
		}
		localStorage.removeItem("state");
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

function showHideGuessedLabels() {
	if (document.getElementById("showGuessedLabels").checked) {
		map.addLayer(cityGuessedLabelsLayerGroup);
	}
	else {
		map.removeLayer(cityGuessedLabelsLayerGroup);
	}
}

function showHideRevealedLabels() {
	if (document.getElementById("showRevealedLabels").checked) {
		map.addLayer(cityRevealedLabelsLayerGroup);
	}
	else {
		map.removeLayer(cityRevealedLabelsLayerGroup);
	}
}

function showHideCountryLabels() {
	if (document.getElementById("showCountryLabels").checked) {
		map.addLayer(countryLabelsLayerGroup);
	}
	else {
		map.removeLayer(countryLabelsLayerGroup);
	}
}

function showHideCountryBoundaries() {
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

