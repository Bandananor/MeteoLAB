# MeteoLab StormLab — validation report

Model version **v2.10.0.1-25-geaaf5fd**, 2026-10-25. Node v24.16.0, 12th Gen Intel(R) Core(TM) i5-12450H, 12 at once, 35 min.

**53 of 53 checks within their bounds**.

Each case runs the model and compares what it gives with the literature or with what the case is meant to show. The bounds hold the model’s current result with a margin, so a change of the physics that moves a result shows here; where the model is known to be off the reference, the bounds say so and the reference lies outside them (see the case’s note and the roadmap, A4 and A7). Made by `npm run validate`; the cases, their references and bounds are in `src/validation/cases.ts`, and the slow tests check the same bounds.

## Density current (Straka et al. 1993), 100 m, 900 s

Source: Straka, Wilhelmson, Wicker, Anderson, Droegemeier 1993, Int. J. Numer. Methods Fluids 17; converged 25 m solution. Run time 4 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| front position (θ′ = −1 K at the ground), km | 14.98 | 15.5 (25 m) | 14.7 … 16 | ✓ |
| θ′ min, K | −9.75 | −9.8 | −11 … −8.5 | ✓ |
| u max, m/s | 34.74 | 36 | 33.5 … 40 | ✓ |
| w min, m/s | −16.08 | −16 | −19 … −13.5 | ✓ |

Converges with the grid (400 → 50 m) to a front ~3 % behind and a u max ~4 % below the reference (34.7 against 36 m/s at 50 and 100 m; ~10 % below, and first-order in dt, before the pressure acted in every RK3 stage, 22.10.2026): known deviation, roadmap A4.

## Rising thermal, dry and saturated (Bryan & Fritsch 2002), 100 m, 1000 s

Source: Bryan & Fritsch 2002, Mon. Wea. Rev. 130; numbers as quoted by Duarte et al. 2014 (arXiv:1311.4265). Run time 6 min.

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

Source: Weisman & Klemp 1982, Mon. Wea. Rev. 110: a split by 40–60 min into a stronger cyclonic right mover and an anticyclonic left mover. Run time 28 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| updraught cores at 4.5 km, 35 min (w > 8 m/s) | 2 | ≥ 2 (split) | ≥ 2 | ✓ |
| separation, left mover north of the right one, km | 5.63 | > 4 (two distinct cells) | ≥ 4 | ✓ |
| right mover w − left mover w, m/s | 8.67 | > 0 (right mover dominant) | ≥ 0 | ✓ |
| right mover UH 2–5 km, m²/s² | 572 | > 0 (cyclonic) | ≥ 0 | ✓ |
| left mover UH 2–5 km, m²/s² | −293 | < 0 (anticyclonic) | ≤ 0 | ✓ |
| strongest updraught at 60 min, m/s | 26.85 | > 15 (long-lived) | ≥ 15 | ✓ |

## Scenario «Летний день», 40 min

Source: meant to grow no mesocyclone. Run time 9 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 39.51 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 250 m²/s², wind at 100 m 21.4 m/s, rain 8.0 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Многоячейковая гроза», 40 min

Source: no rotation is asked of it. Run time 8 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 33.64 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 39 | — | ≥ 0 | ✓ |

UH max 360 m²/s², wind at 100 m 20.8 m/s, rain 4.1 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Классическая суперячейка», 40 min

Source: meant to grow a supercell. Run time 11 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 55.25 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1407 | ≥ 600 | ≥ 600 | ✓ |

UH max 2222 m²/s², wind at 100 m 33.4 m/s, rain 23.7 mm, hail 1.2 cm aloft / 2.8 mm at the ground.

## Scenario «Суперячейка WK», 40 min

Source: meant to grow a supercell. Run time 10 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 50.12 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1203 | ≥ 600 | ≥ 600 | ✓ |

UH max 1074 m²/s², wind at 100 m 20.7 m/s, rain 35.2 mm, hail 1.1 cm aloft / 1.5 mm at the ground.

## Scenario «HSLC», 40 min

Source: meant to grow a supercell. Run time 9 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 20.84 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1434 | ≥ 600 | ≥ 600 | ✓ |

UH max 819 m²/s², wind at 100 m 25.0 m/s, rain 14.1 mm, hail 1.2 cm aloft / 2.0 mm at the ground.

## Scenario «Микропорыв», 40 min

Source: meant to grow no mesocyclone. Run time 8 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 22.44 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 170 m²/s², wind at 100 m 26.2 m/s, rain 3.3 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Тропическая конвекция», 40 min

Source: meant to grow no mesocyclone. Run time 8 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 24.61 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 96 m²/s², wind at 100 m 17.9 m/s, rain 21.6 mm, hail 0.7 cm aloft / 0.1 mm at the ground.

## Situation «Тёплый сектор и холодный фронт», with and without its trigger

Source: the situation’s story (2.6). Run time 25 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| with the front: max updraught, m/s | 46.18 | storms on the front | ≥ 25 | ✓ |
| with the front: highest cloud top, km | 13.72 | deep storms | ≥ 10 | ✓ |
| without the front: max updraught, m/s | 4.41 | no storms (the cap holds) | 0 … 10 | ✓ |

## Situation «Высотная ложбина», with and without its trigger

Source: the situation’s story (2.6). Run time 35 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| with the trough: max updraught, m/s | 31.48 | storms by 11:30 | ≥ 20 | ✓ |
| without the trough: max updraught, m/s | 26.22 | storms by 11:30 too | ≥ 15 | ✓ |
| with the trough: 12:10–12:50 mean updraught, m/s | 11.15 | new cells keep going | ≥ 8 | ✓ |
| 12:10–12:50 mean updraught, with − without the trough, m/s | 5.98 | the trough makes them last | ≥ 3 | ✓ |
| with the trough: heaviest rain 12:10–12:50, mm/h | 56.24 | downpours go on | ≥ 10 | ✓ |
| without the trough: heaviest rain 12:10–12:50, mm/h | 1.58 | the rain has ended by 12:20 | 0 … 5 | ✓ |

Recalibrated 22.10.2026 for 2.7.2’s ice from processes (the trough −4 K instead of −3, the window 12:10–12:50 instead of 12:30–13:00): late weak updraughts keep their cloud water supercooled and get less heat of freezing (tests/bench/glaciation.ts).

## Situation «Тёплый воздух над слоем: гроз не будет», with and without its trigger

Source: the situation’s story (2.6). Run time 23 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| with the warm air aloft: max updraught, m/s | 3.88 | no storms | 0 … 8 | ✓ |
| with the warm air aloft: highest cloud top, km | 0 | shallow cumulus | 0 … 4 | ✓ |
| without it: max updraught, m/s | 26.22 | storms | ≥ 20 | ✓ |
| without it: highest cloud top, km | 10.39 | deep storms | ≥ 8 | ✓ |
