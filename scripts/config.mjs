// Área de estudio: casco urbano de Elche dentro de sus rondas
// (Ronda Oest de Carrús, Ronda Sud / EL-20, Ronda Est y Ronda Nord).
export const BBOX = {
  south: 38.2425,
  west: -0.734,
  north: 38.297,
  east: -0.65,
};

// Origen de coordenadas locales (metros): centro del área.
export const ORIGIN = {
  lat: (BBOX.south + BBOX.north) / 2,
  lon: (BBOX.west + BBOX.east) / 2,
};

// Zona de Bajas Emisiones, fase 1 (ordenanza municipal): entre la margen este del
// Vinalopó, Filet de Fora / Pont dels Ortissos / Porta d'Alacant, Mestre Albéniz y
// carrer de l'Àngel. Polígono aproximado en coordenadas locales (x este, z sur).
export const ZBE_POLYGON = [
  [-600, 150], [-255, 150], [-280, 285], [-295, 410], [-330, 600], [-375, 860],
  [-615, 860], [-650, 510], [-600, 230],
];

// Intensidad media diaria estimada por sentido en los accesos (vehículos/día).
// Fuentes: CV-865 17.221 veh/día (Generalitat); A-7/A-70 Elx–Crevillent ≈ 65.000 (Ministerio);
// el resto son estimaciones según la jerarquía viaria.
export const GATEWAY_IMD = [
  { match: /CV-865|Santa Pola/i, perDir: 8600 },
  { match: /Autovia de la Mediterr|A-7\b/i, perDir: 26000 },
  { match: /EL-20|Ronda Est|Circumval/i, perDir: 15000 },
  { match: /Via Parc|CV-86\b/i, perDir: 11000 },
  { match: /N-340|Crevillent|Alacant|Alicante/i, perDir: 9000 },
  { match: /CV-84\b|Novelda/i, perDir: 7500 },
  { match: /CV-855|Dolores/i, perDir: 4500 },
  { match: /CV-850|Castella/i, perDir: 3500 },
  { match: /CV-851|CV-853|CV-854|CV-856|Baia|Marina|Asprella/i, perDir: 2500 },
];
export const GATEWAY_DEFAULT_BY_CLASS = [
  // motorway, motorway_link, trunk, trunk_link, primary, primary_link, secondary, secondary_link,
  // tertiary, tertiary_link, unclassified, residential, living_street
  20000, 4000, 9000, 2500, 6000, 2000, 3000, 1200, 900, 500, 200, 120, 40,
];

// Líneas de autobús urbano con mayor demanda (Avanza Elx, 2026): mayor frecuencia.
export const BUS_HEADWAY_MIN = { B: 12, D: 12, K1: 12, K2: 12, M: 12, default: 20 };

// Extensión del modelo digital del terreno: el área de estudio con ~2 km de margen,
// para que el relieve continúe más allá de las calles simuladas.
export const DEM_BBOX = {
  south: BBOX.south - 0.018,
  west: BBOX.west - 0.023,
  north: BBOX.north + 0.018,
  east: BBOX.east + 0.023,
};
