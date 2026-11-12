# MeteoLab StormLab — validation report

Model version **v2.11.0-7-gdd4075b**, 2026-11-12. Node v24.16.0, 12th Gen Intel(R) Core(TM) i5-12450H, 12 at once, 35 min.

**53 of 53 checks within their bounds**.

Each case runs the model and compares what it gives with the literature or with what the case is meant to show. The bounds hold the model’s current result with a margin, so a change of the physics that moves a result shows here; where the model is known to be off the reference, the bounds say so and the reference lies outside them (see the case’s note and the roadmap, A4 and A7). Made by `npm run validate`; the cases, their references and bounds are in `src/validation/cases.ts`, and the slow tests check the same bounds.

## Density current (Straka et al. 1993), 100 m, 900 s

Source: Straka, Wilhelmson, Wicker, Anderson, Droegemeier 1993, Int. J. Numer. Methods Fluids 17; converged 25 m solution. Run time 2 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| front position (θ′ = −1 K at the ground), km | 14.98 | 15.5 (25 m) | 14.7 … 16 | ✓ |
| θ′ min, K | −9.75 | −9.8 | −11 … −8.5 | ✓ |
| u max, m/s | 34.74 | 36 | 33.5 … 40 | ✓ |
| w min, m/s | −16.08 | −16 | −19 … −13.5 | ✓ |

Converges with the grid (400 → 50 m) to a front ~3 % behind and a u max ~4 % below the reference (34.7 against 36 m/s at 50 and 100 m; ~10 % below, and first-order in dt, before the pressure acted in every RK3 stage, 22.10.2026): known deviation, roadmap A4.

## Rising thermal, dry and saturated (Bryan & Fritsch 2002), 100 m, 1000 s

Source: Bryan & Fritsch 2002, Mon. Wea. Rev. 130; numbers as quoted by Duarte et al. 2014 (arXiv:1311.4265). Run time 5 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| dry: top of the thermal, km | 8.10 | ~8 | 7.6 … 8.6 | ✓ |
| dry: buoyancy-weighted centre, km | 6.27 | — | 5.8 … 6.8 | ✓ |
| dry: w max, m/s | 14.63 | 13.9 | 12.5 … 15.5 | ✓ |
| moist: w max, m/s | 16.22 | 15.7 | 14.2 … 17.3 | ✓ |
| moist / dry w max | 1.11 | 1.13 | 1.03 … 1.25 | ✓ |
| moist: θe′ max, K | 4.40 | 4.10 | 3.6 … 4.9 | ✓ |
| moist: θe′ min, K | −0.35 | −0.31 | ≥ −0.7 | ✓ |

θe here is the approximate one (not the paper’s wet θe), so its extremes compare loosely.

## Supercell split (Weisman & Klemp 1982), 96 × 72 km, 60 min

Source: Weisman & Klemp 1982, Mon. Wea. Rev. 110: a split by 40–60 min into a stronger cyclonic right mover and an anticyclonic left mover. Run time 27 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| updraught cores at 4.5 km, 35 min (w > 8 m/s) | 2 | ≥ 2 (split) | ≥ 2 | ✓ |
| separation, left mover north of the right one, km | 5.63 | > 4 (two distinct cells) | ≥ 4 | ✓ |
| right mover w − left mover w, m/s | 8.66 | > 0 (right mover dominant) | ≥ 0 | ✓ |
| right mover UH 2–5 km, m²/s² | 572 | > 0 (cyclonic) | ≥ 0 | ✓ |
| left mover UH 2–5 km, m²/s² | −293 | < 0 (anticyclonic) | ≤ 0 | ✓ |
| strongest updraught at 60 min, m/s | 26.92 | > 15 (long-lived) | ≥ 15 | ✓ |

## Scenario «Летний день», 40 min

Source: meant to grow no mesocyclone. Run time 6 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 39.48 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 249 m²/s², wind at 100 m 21.1 m/s, rain 7.9 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Многоячейковая гроза», 40 min

Source: no rotation is asked of it. Run time 7 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 48.98 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | — | ≥ 0 | ✓ |

UH max 545 m²/s², wind at 100 m 23.7 m/s, rain 8.9 mm, hail 0.3 cm aloft / 0.0 mm at the ground.

## Scenario «Классическая суперячейка», 40 min

Source: meant to grow a supercell. Run time 10 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 55.04 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1407 | ≥ 600 | ≥ 600 | ✓ |

UH max 2219 m²/s², wind at 100 m 33.0 m/s, rain 23.6 mm, hail 1.2 cm aloft / 2.8 mm at the ground.

## Scenario «Суперячейка WK», 40 min

Source: meant to grow a supercell. Run time 8 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 50.12 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1203 | ≥ 600 | ≥ 600 | ✓ |

UH max 1074 m²/s², wind at 100 m 20.7 m/s, rain 35.2 mm, hail 1.1 cm aloft / 1.5 mm at the ground.

## Scenario «HSLC», 40 min

Source: meant to grow a supercell. Run time 8 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 20.46 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1434 | ≥ 600 | ≥ 600 | ✓ |

UH max 765 m²/s², wind at 100 m 24.9 m/s, rain 14.0 mm, hail 1.2 cm aloft / 1.8 mm at the ground.

## Scenario «Микропорыв», 40 min

Source: meant to grow no mesocyclone. Run time 7 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 22.44 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 170 m²/s², wind at 100 m 25.9 m/s, rain 3.3 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Тропическая конвекция», 40 min

Source: meant to grow no mesocyclone. Run time 7 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 24.46 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 96 m²/s², wind at 100 m 17.9 m/s, rain 21.2 mm, hail 0.7 cm aloft / 0.1 mm at the ground.

## Situation «Тёплый сектор и холодный фронт», with and without its trigger

Source: the situation’s story (2.6). Run time 23 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| with the front: max updraught, m/s | 42.87 | storms on the front | ≥ 25 | ✓ |
| with the front: highest cloud top, km | 13.72 | deep storms | ≥ 10 | ✓ |
| without the front: max updraught, m/s | 3.04 | no storms (the cap holds) | 0 … 10 | ✓ |

## Situation «Высотная ложбина», with and without its trigger

Source: the situation’s story (2.6). Run time 35 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| with the trough: max updraught, m/s | 31.40 | storms by 11:30 | ≥ 20 | ✓ |
| without the trough: max updraught, m/s | 26.31 | storms by 11:30 too | ≥ 15 | ✓ |
| with the trough: 12:10–12:50 mean updraught, m/s | 11.57 | new cells keep going | ≥ 8 | ✓ |
| 12:10–12:50 mean updraught, with − without the trough, m/s | 6.42 | the trough makes them last | ≥ 3 | ✓ |
| with the trough: heaviest rain 12:10–12:50, mm/h | 56.25 | downpours go on | ≥ 10 | ✓ |
| without the trough: heaviest rain 12:10–12:50, mm/h | 0.39 | the rain has ended by 12:20 | 0 … 5 | ✓ |

Recalibrated 22.10.2026 for 2.7.2’s ice from processes (the trough −4 K instead of −3, the window 12:10–12:50 instead of 12:30–13:00): late weak updraughts keep their cloud water supercooled and get less heat of freezing (tests/bench/glaciation.ts).

## Situation «Тёплый воздух над слоем: гроз не будет», with and without its trigger

Source: the situation’s story (2.6). Run time 22 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| with the warm air aloft: max updraught, m/s | 3.88 | no storms | 0 … 8 | ✓ |
| with the warm air aloft: highest cloud top, km | 0 | shallow cumulus | 0 … 4 | ✓ |
| without it: max updraught, m/s | 26.31 | storms | ≥ 20 | ✓ |
| without it: highest cloud top, km | 10.39 | deep storms | ≥ 8 | ✓ |

## Known deviations from nature (roadmap A7)

Measured on the same model; the bounds here are the range observed in nature, so ✗ is expected until the roadmap item named fixes it (the slow test `src/core/deviations.test.ts` marks each one `it.fails`). They do not count in the total above. The cases are in `src/validation/deviations.ts`.

### Classic supercell, 60 min: outflow, hail and lightning

Nature: RFD θv′ at the ground: under ~2 K in strongly tornadic RFDs, ~4–7 K in nontornadic ones (Markowski, Straka & Rasmussen 2002, MWR 130, 1692, as quoted by later papers); SHIP > 1 — an environment favourable for hail ≥ 5 cm (SPC); +CG 8.7–10.6 % of ground flashes over the USA, regionally < 2 to > 25 % (Rudlosky & Fuelberg 2010, MWR 138, 3623; Orville et al. 2011, MWR 139, 1305). Cause: the outflow: rain evaporation with the fixed Marshall-Palmer N₀ gives 65–75 % of the cooling (D2; N₀ 1e6 would bring it to ~5 K); hail: single-moment, no size sorting or growth along trajectories; −CG: the graupel’s charging sign at −5…−15 °C (B6). Fixed by: B1, B2, B6. Run time 14 min.

| Quantity | Model | Nature | |
|---|---:|---|:-:|
| outflow θv deficit under the low-level rotation, max 30–60 min, K | 10.03 | ≲ 2 tornadic, 4–7 nontornadic RFDs | ✗ |
| largest hail at the ground, mm | 11.95 | ≥ 50 favoured (SHIP > 1 here) | ✗ |
| share of positive ground flashes | 1 | 0.09–0.11 over the USA, regionally 0.02–0.25 | ✗ |

66 CG and 4325 IC flashes; strongest updraught 55.0 m/s; max reflectivity 73 dBZ, VIL 60 kg/m², MESH 69 mm; the largest outflow deficit anywhere 11.6 K.

### Ordinary cell («Summer day»), 40 min: the graupel core

Nature: ordinary (pulse) cells: core ~50–60 dBZ (a forecasters’ rule of thumb; no peer-reviewed typical maximum found yet). Cause: single-moment graupel with a fixed N₀ puts its mass in a few large particles (Z ∝ N₀^−¾); with it VIL and MESH run high. Fixed by: B1. Run time 6 min.

| Quantity | Model | Nature | |
|---|---:|---|:-:|
| max reflectivity of the cell, dBZ | 70.46 | 50–60 | ✗ |

VIL 46 kg/m², MESH 58 mm, strongest updraught 39.6 m/s.

### Tropical convection over the ocean, 40 min: the updraught

Nature: GATE oceanic cores: only 10 % have a mean w above 5 m/s (LeMone & Zipser 1980, JAS 37, 2444); TAMEX median under 3 m/s (Jorgensen & LeMone 1989, JAS 46, 621); peaks of 10–15 m/s rare (not verified). Cause: the sea’s heat flux is set by the sun as over land; the ~1 km grid; no boundary-layer scheme. Fixed by: B3, B4. Run time 6 min.

| Quantity | Model | Nature | |
|---|---:|---|:-:|
| strongest updraught, m/s | 24.51 | core means mostly < 5, peaks rarely 10–15 | ✗ |

max reflectivity 73 dBZ.

### No shear, high CAPE (WK, moisture 1.1), 40 min: the updraught against parcel theory

Nature: about half of parcel theory’s √(2 CAPE) in ordinary convection (a textbook rule, e.g. Stull 2017, ch. 14; no measured ratio verified yet), more in supercells (Peters, Nowotarski & Morrison 2019, JAS 76, 3169). Cause: at 1.2 km entrainment is under-resolved (A2: the peak w still grows with resolution). Fixed by: A2, C1. Run time 7 min.

| Quantity | Model | Nature | |
|---|---:|---|:-:|
| strongest updraught / √(2 ML CAPE) | 0.86 | 0.5–0.6 | ✗ |

ML CAPE 3931 J/kg, strongest updraught 76.4 m/s.

Without a number to test yet:

- **LP / classic / HP supercells do not differ by environment** — tests/bench/sctype.ts: the same precipitation distribution in LP, classic and HP environments (B1).
- **The cell tracker’s splits are random** — 21.10.2026: none at 30 m/s straight shear, no pattern in other runs — the tracker against the vorticity fields (A8).
- **Initiation by the sun is slow at 1.2 km** — a 1.5 K cap with CIN ~10 J/kg holds because of the grid (C1).
- **A squall line at 1.2 km builds its cold pool late** — 10.11.2026, tests/bench/lines.ts us=20 dx=1.2: C 15 m/s at 60 min, 17 at 90, 24 at 120 (Weisman & Rotunno 2004: 19–26), the line filled over 30 → 68 % of its length; only two hours run, the decay seen earlier on coarse grids comes later (Э1).
- **Line-end vortices do not tell a bow from a plain line** — 10.11.2026, tests/bench/organize.ts: the strongest node vorticity at 2.5 km near the ends is 4–11e-3 1/s on the cold front’s line (1.2 km) and 8–17e-3 on the bow echo (1 km), both signs at both ends; ORG.vortex 2e-3 passes every line — a circulation over an area is needed (Э1).
- **A storm from a real sounding weakens 20–40 min after the nudging** — Omaha 68 → 8 m/s by 60 min; subsidence on the standard domain is only part of it (E10).
