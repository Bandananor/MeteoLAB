# MeteoLab StormLab — validation report

Model version **v2.8.0-22-ge2fee7d-dirty**, 2026-10-21. Node v24.16.0, 12th Gen Intel(R) Core(TM) i5-12450H, 10 at once, 42 min.

**38 of 38 checks within their bounds**.

Each case runs the model and compares what it gives with the literature or with what the case is meant to show. The bounds hold the model’s current result with a margin, so a change of the physics that moves a result shows here; where the model is known to be off the reference, the bounds say so and the reference lies outside them (see the case’s note and the roadmap, A4 and A7). Made by `npm run validate`; the cases, their references and bounds are in `src/validation/cases.ts`, and the slow tests check the same bounds.

## Density current (Straka et al. 1993), 100 m, 900 s

Source: Straka, Wilhelmson, Wicker, Anderson, Droegemeier 1993, Int. J. Numer. Methods Fluids 17; converged 25 m solution. Run time 2 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| front position (θ′ = −1 K at the ground), km | 14.99 | 15.5 (25 m) | 14.7 … 16 | ✓ |
| θ′ min, K | −9.81 | −9.8 | −11 … −8.5 | ✓ |
| u max, m/s | 32.64 | 36 | 30.5 … 40 | ✓ |
| w min, m/s | −15.19 | −16 | −19 … −13.5 | ✓ |

Converges with the grid (400 → 50 m) to a front ~3 % behind and a u max ~10 % below the reference: known deviation, roadmap A4.

## Rising thermal, dry and saturated (Bryan & Fritsch 2002), 100 m, 1000 s

Source: Bryan & Fritsch 2002, Mon. Wea. Rev. 130; numbers as quoted by Duarte et al. 2014 (arXiv:1311.4265). Run time 4 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| dry: top of the thermal, km | 8.10 | ~8 | 7.6 … 8.6 | ✓ |
| dry: buoyancy-weighted centre, km | 6.27 | — | 5.8 … 6.8 | ✓ |
| dry: w max, m/s | 14.51 | 13.9 | 12.5 … 15.5 | ✓ |
| moist: w max, m/s | 16.21 | 15.7 | 14.2 … 17.3 | ✓ |
| moist / dry w max | 1.12 | 1.13 | 1.03 … 1.25 | ✓ |
| moist: θe′ max, K | 4.45 | 4.10 | 3.6 … 4.9 | ✓ |
| moist: θe′ min, K | −0.36 | −0.31 | ≥ −0.7 | ✓ |

θe here is the approximate one (not the paper’s wet θe), so its extremes compare loosely.

## Supercell split (Weisman & Klemp 1982), 96 × 72 km, 60 min

Source: Weisman & Klemp 1982, Mon. Wea. Rev. 110: a split by 40–60 min into a stronger cyclonic right mover and an anticyclonic left mover. Run time 42 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| updraught cores at 4.5 km, 35 min (w > 8 m/s) | 2 | ≥ 2 (split) | ≥ 2 | ✓ |
| separation, left mover north of the right one, km | 5.63 | > 4 (two distinct cells) | ≥ 4 | ✓ |
| right mover w − left mover w, m/s | 8.43 | > 0 (right mover dominant) | ≥ 0 | ✓ |
| right mover UH 2–5 km, m²/s² | 580 | > 0 (cyclonic) | ≥ 0 | ✓ |
| left mover UH 2–5 km, m²/s² | −364 | < 0 (anticyclonic) | ≤ 0 | ✓ |
| strongest updraught at 60 min, m/s | 26.62 | > 15 (long-lived) | ≥ 15 | ✓ |

## Scenario «Летний день», 40 min

Source: meant to grow no mesocyclone. Run time 5 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 40.51 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 245 m²/s², wind at 100 m 21.1 m/s, rain 7.5 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Многоячейковая гроза», 40 min

Source: no rotation is asked of it. Run time 5 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 34.52 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 39 | — | ≥ 0 | ✓ |

UH max 362 m²/s², wind at 100 m 20.6 m/s, rain 4.1 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Классическая суперячейка», 40 min

Source: meant to grow a supercell. Run time 9 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 56.05 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1416 | ≥ 600 | ≥ 600 | ✓ |

UH max 2219 m²/s², wind at 100 m 33.1 m/s, rain 24.0 mm, hail 1.2 cm aloft / 2.9 mm at the ground.

## Scenario «Суперячейка WK», 40 min

Source: meant to grow a supercell. Run time 7 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 50.70 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1218 | ≥ 600 | ≥ 600 | ✓ |

UH max 1101 m²/s², wind at 100 m 20.3 m/s, rain 34.6 mm, hail 1.1 cm aloft / 1.5 mm at the ground.

## Scenario «HSLC», 40 min

Source: meant to grow a supercell. Run time 6 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 21.58 | — | ≥ 0 | ✓ |
| longest mesocyclone, s | 1434 | ≥ 600 | ≥ 600 | ✓ |

UH max 866 m²/s², wind at 100 m 24.9 m/s, rain 14.3 mm, hail 1.3 cm aloft / 2.3 mm at the ground.

## Scenario «Микропорыв», 40 min

Source: meant to grow no mesocyclone. Run time 5 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 23.05 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 170 m²/s², wind at 100 m 25.8 m/s, rain 3.4 mm, hail 0.0 cm aloft / 0.0 mm at the ground.

## Scenario «Тропическая конвекция», 40 min

Source: meant to grow no mesocyclone. Run time 5 min.

| Quantity | Model | Reference | Bounds | |
|---|---:|---|---|:-:|
| values clipped by the limiters | 0 | 0 | = 0 | ✓ |
| max updraught, m/s | 26.02 | ≤ 55 (observed storms ≤ ~0.6 √(2 CAPE)) | 0 … 55 | ✓ |
| longest mesocyclone, s | 0 | < 600 | 0 … 600 | ✓ |

UH max 99 m²/s², wind at 100 m 18.4 m/s, rain 21.4 mm, hail 0.7 cm aloft / 0.1 mm at the ground.
