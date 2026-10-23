# Elx · Trànsit 3D — simulador de tráfico de Elche

Simulador microscópico del tráfico de **Elche (Elx)** con visualización 3D en el navegador.
Cada vehículo se mueve por la red viaria real de la ciudad (OpenStreetMap), entre los
62.000 edificios del Catastro, el Palmeral y las rondas, con semáforos, glorietas,
prioridades, autobuses urbanos y una demanda que cambia a lo largo del día.

```bash
npm install
npm run dev        # http://localhost:5180
```

Los datos procesados ya están en `public/data/`, así que no hace falta descargar nada para
arrancar. Para regenerarlos desde las fuentes originales:

```bash
npm run data       # OSM (Overpass) + Catastro (INSPIRE) + procesado
```

## Qué incluye

**Ciudad en 3D**

- Red viaria de OSM recortada al casco urbano dentro de las rondas (≈7,3 × 6 km): 490 km de
  ejes, carriles por sentido, límites de velocidad, sentidos únicos, puentes con rampas y
  túneles.
- 62.291 volúmenes de edificio del **Catastro** (INSPIRE), con su número real de plantas y uso
  (residencial, industrial, oficinas, comercio, servicios públicos). Los monumentos de OSM
  sustituyen a sus parcelas; la Basílica de Santa María lleva cúpula y campanario.
- Usos del suelo, cauce del Vinalopó, parques, plazas peatonales y vías del tren pintados en
  una textura sobre el terreno.
- ≈53.000 palmeras y árboles: los ejemplares de OSM y los generados dentro de los huertos del
  Palmeral, parques y zonas verdes.
- Marcas viales en el sombreador (carriles, ejes, pasos de peatones, líneas de detención y
  ceda el paso), aceras con bordillo, isletas de glorieta y alumbrado público nocturno.
- Sol real de Elche (latitud, declinación y horario de verano) según la hora y la época del
  año, cielo, niebla, sombras, ventanas que se iluminan de noche y faros de los vehículos.

**Simulación**

- **Seguimiento de vehículos:** Intelligent Driver Model (IDM) con parámetros por tipo
  (turismo, furgoneta, camión, autobús, moto) y variación por conductor.
- **Cambio de carril:** MOBIL simplificado, con cambios obligatorios para colocarse antes de
  girar, aparcar o llegar a una parada de autobús.
- **Intersecciones:** maniobras entre tramos con conflictos precalculados (trayectorias que se
  cortan o confluyen), reserva del cruce, «no bloquear el cruce», prioridad del anillo en
  glorietas, STOP y ceda el paso de OSM, prioridad por jerarquía viaria y prioridad a la
  derecha entre calles iguales, incorporación en cremallera y desbloqueo por impaciencia.
- **Semáforos:** 78 reguladores reconstruidos a partir de los 231 semáforos de OSM, con dos
  fases por eje y reparto de verde según carriles y jerarquía. Modos: tiempo fijo, onda verde
  este–oeste, accionados por demanda (detectores) y apagados (ámbar intermitente).
- **Rutas:** A* sobre el grafo de tramos con prohibiciones de giro de OSM, tiempos de viaje
  observados y reencaminamiento dinámico de los vehículos detenidos.
- **Autobuses urbanos:** 25 recorridos de las líneas reales de OSM (A, B, C, D, E, F, G, H, I,
  J, K2, L, M, N1–N3, NT, CN, R1–R4) con sus paradas y tiempos de parada.
- **Demanda:** viajes internos, de entrada, de salida y de paso, con perfil horario de día
  laborable (puntas a las 8, 13–14 y 19 h). Orígenes y destinos ponderados por la superficie
  construida de cada calle según su uso, más polos (hospitales, universidad, centros
  comerciales, estaciones).
- **Indicadores:** vehículos en red, velocidad media, viajes/h, tiempo y demora media,
  porcentaje de detenidos, CO₂ estimado con un modelo de potencia en rueda, y mapa de
  congestión por tramo.

## Controles

| Acción | Cómo |
| --- | --- |
| Mover / girar / acercar | arrastrar · botón derecho · rueda |
| Pausar / reanudar | `Espacio` o ⏸ |
| Velocidad de simulación | `1`–`6` o los botones ×1 … ×60 |
| Mapa de congestión | `H` o capa «Congestión» |
| Seleccionar vehículo, semáforo o calle | clic (ficha con datos y ruta resaltada) |
| Seguir al vehículo / vista conductor | botones de la ficha · `F` |
| Cortar o reabrir una calle | herramienta «Cortar / abrir calles» o botón de la ficha |
| Deseleccionar | `Esc` |

**Escenarios:** punta de mañana, mediodía, punta de tarde y noche; partido en el Martínez
Valero (llegadas desde las 19:00 y salida a las 22:50); Zona de Bajas Emisiones del centro
histórico (fase 1 de la ordenanza: entre el Vinalopó y Filet de Fora, de Mestre Albéniz a
l'Àngel), y corte del Pont de Canalejas o del Pont d'Altamira.

## Calibración y fuentes

| Dato | Valor usado | Fuente |
| --- | --- | --- |
| Población | 245.575 (municipio), 198.295 (núcleo) | OSM / INE 2025 |
| Reparto modal interno | coche 49 %, a pie 40 %, transporte público 9 % | [PMUS de Elche](https://alicanteplaza.es/que-dice-el-pmus-de-elche-no-se-utiliza-mas-el-transporte-publico-por-falta-de-servicio-y-comodidad) |
| Duración media de viaje | 20,7 min (todos los modos) | PMUS de Elche |
| Parque móvil (2018) | 160.583 vehículos (70 % turismos, 12,5 % furgonetas y camiones, 15 % motos) | [PMUS de Elche](https://alicanteplaza.es/que-dice-el-pmus-de-elche-no-se-utiliza-mas-el-transporte-publico-por-falta-de-servicio-y-comodidad) |
| CV-865 Elche–Santa Pola | 17.221 veh/día | [Generalitat vía AlicantePlaza](https://alicanteplaza.es/el-desdoble-de-la-carretera-entre-elche-y-santa-pola-sera-una-via-parque-y-se-invertiran-12-millones) |
| A-7/A-70 Elche–Crevillent | ≈65.000 veh/día | [Ministerio de Transportes vía El Periòdic](https://www.elperiodic.com/elx/tramo-urbano-ronda-pasa-titularidad-municipal-ministerio-confirma-pronto-mejorara-entre-elche-crevillente_815100) |
| Líneas de autobús más usadas | B, D, K1, K2, M (más frecuencia) | [Avanza Elx, 2026](https://alicanteplaza.es/alicanteplaza/elcheplaza/el-servicio-de-autobus-en-elche-crece-en-2026-con-54-millones-de-viajeros) |
| Perímetro de la ZBE | fase 1 de la ordenanza | [AlicantePlaza](https://alicanteplaza.es/zbe-elche-perimetro-centro) |
| Límites por defecto | 50 / 30 / 20 km/h según carriles | RD 970/2020 |
| Hora punta | 7,5–10 % de la IMD | estudios de tráfico de la Generalitat |

Con esto, la demanda base es de unos 88.000 viajes diarios internos en coche (núcleo urbano,
40 % de los desplazamientos internos) más ≈120.000 de entrada y ≈157.000 de salida por los
accesos, de los que una parte es tráfico de paso por la A-7 y la EL-20. Las intensidades de los
accesos sin aforo publicado (N-340, CV-84, CV-855…) son estimaciones según la jerarquía viaria;
están en `scripts/config.mjs`.

## Arquitectura

```
scripts/                     preprocesado (Node)
  fetch-osm.mjs              descarga por Overpass (calles, edificios, usos, árboles, PDI, bus, tren)
  fetch-catastro.mjs         edificios INSPIRE del Catastro (municipio 03065)
  build-data.mjs             genera public/data/*.json
  lib/network.mjs            grafo: tramos, carriles, maniobras, conflictos, semáforos, rotondas
  lib/catastro.mjs           lector GML en streaming y conversión UTM 30N → local
  lib/buildings.mjs          alturas, usos y monumentos
  lib/areas.mjs              usos del suelo y generación del Palmeral
src/sim/                     simulación (Web Worker)
  simulation.ts              IDM, MOBIL, cruces, altas/bajas, autobuses, indicadores
  network.ts router.ts signals.ts demand.ts
  worker.ts protocol.ts      bucle de simulación e intercambio de instantáneas
src/render/                  Three.js
  scene.ts                   cámara, controles, sol, cielo, niebla, sombras
  roads.ts                   calzadas, marcas viales, congestión, cortes, rutas
  buildings.ts vegetation.ts vehicles.ts signals.ts labels.ts landmarks.ts ground.ts
src/ui/                      estilos y gráfica
```

La simulación corre en un Web Worker con paso de 0,2 s y envía instantáneas que el hilo
principal interpola en cada fotograma; con unos 3.000–5.000 vehículos va a ×60 sin perder
fotogramas en un portátil reciente.

## Limitaciones

- No se simulan peatones ni bicicletas; los semáforos de paso de peatones sí detienen el
  tráfico.
- La demanda es sintética (no hay una matriz origen–destino pública); está calibrada en
  volumen y reparto horario, no en cada calle.
- Los planes semafóricos se reconstruyen a partir de la posición de los semáforos, no de los
  planes reales del Ayuntamiento.
- El cauce del Vinalopó se representa a nivel de calle y los túneles ocultan los vehículos.

## Licencias de los datos

- Red viaria, usos del suelo, árboles, PDI y líneas de autobús: © colaboradores de
  OpenStreetMap, [ODbL](https://www.openstreetmap.org/copyright).
- Edificios: © Dirección General del Catastro, servicio INSPIRE de edificios.
