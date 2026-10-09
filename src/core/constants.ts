export const G = 9.81, CP = 1004, LV = 2.5e6, KAPPA = .286, RD = 287.05, RV = 461.5, EPS = .622, OMEGA = 7.2921e-5
/**
 * Model time step, s. 3 s since 2026-10-09 (was 1 s): the strongest updraughts cross ~0.3 of a cell per step, and the
 * WK supercell, Летний день and HSLC gave the same w, UH, mesocyclone time, rain and hail with 1, 2 and 3 s.
 */
export const DT = 3
