import * as THREE from 'three'
import type { ScalarField } from '../core'

export type FieldMode = 'composite' | ScalarField

export interface FieldInfo { title: string; units: string; min: number; max: number; diverging: boolean; threshold: number; stops: string[] }

const DIVERGING = ['#24476b', '#4d86b3', '#a9c9df', '#f1efe9', '#eab58f', '#cf6d49', '#8f2a1f']

export const FIELDS: Record<ScalarField, FieldInfo> = {
  updraft: { title: 'Вертикальная скорость', units: 'м/с', min: -15, max: 15, diverging: true, threshold: .25, stops: DIVERGING },
  theta: { title: 'Отклонение температуры от окружения', units: 'K', min: -4, max: 4, diverging: true, threshold: .3, stops: DIVERGING },
  moisture: { title: 'Относительная влажность', units: '%', min: 0, max: 100, diverging: false, threshold: .85, stops: ['#7a5a33', '#b89a63', '#e3dcc0', '#9ccbbd', '#4b9aa3', '#1f5d78'] },
  vorticity: { title: 'Вертикальная завихренность', units: '10⁻³ с⁻¹', min: -4, max: 4, diverging: true, threshold: .3, stops: DIVERGING },
  helicity: { title: 'Вращение восходящего потока UH (слой 2–5 км)', units: 'м²/с²', min: -300, max: 300, diverging: true, threshold: .3, stops: DIVERGING },
  coldpool: { title: 'Охлаждение от испарения осадков', units: 'K', min: 0, max: 8, diverging: false, threshold: .15, stops: ['#f1efe9', '#b9d7e6', '#6ea6cc', '#3769a0', '#1d3565'] },
}

export function colormapTexture(stops: string[]) {
  const data = new Uint8Array(256 * 4), rgb = stops.map(s => [1, 3, 5].map(k => parseInt(s.slice(k, k + 2), 16)))
  for (let i = 0; i < 256; i++) {
    const f = i / 255 * (rgb.length - 1), k = Math.min(rgb.length - 2, Math.floor(f)), t = f - k
    for (let c = 0; c < 3; c++) data[i * 4 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * t
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, 256, 1)
  tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true
  return tex
}
