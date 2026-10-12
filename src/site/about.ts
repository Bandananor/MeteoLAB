// «О модели» and «Как пользоваться»: the contents mark the section being read.
import './site'

const links = [...document.querySelectorAll<HTMLAnchorElement>('.toc a[href^="#"]')]
const sections = links.map(a => document.querySelector<HTMLElement>(a.getAttribute('href')!)).filter((s): s is HTMLElement => !!s)
const mark = () => {
  // The last heading above the upper third of the screen.
  let current = sections[0]
  for (const s of sections) if (s.getBoundingClientRect().top < innerHeight / 3) current = s
  for (const a of links) { if (a.getAttribute('href') === `#${current.id}`) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current') }
}
addEventListener('scroll', mark, { passive: true }); mark()
