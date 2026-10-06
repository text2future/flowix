import type { PropertyIconKind } from '@/lib/property-types';

export function createPropertySvgIcon(
  kind: PropertyIconKind | 'properties',
): SVGSVGElement {
  if (kind === 'number') return stylePropertyTypeSvgIcon(createNumberPropertySvgIcon());
  if (kind === 'color') return stylePropertyTypeSvgIcon(createColorPropertySvgIcon());
  if (kind === 'date') return stylePropertyTypeSvgIcon(createDatePropertySvgIcon());
  if (kind === 'boolean') return stylePropertyTypeSvgIcon(createBooleanPropertySvgIcon());
  if (kind === 'note') return stylePropertyTypeSvgIcon(createNotePropertySvgIcon());

  const paths: Record<Exclude<PropertyIconKind, 'number' | 'date' | 'boolean' | 'color' | 'note'> | 'properties', string> = {
    properties: 'M5 6h14M5 12h14M5 18h14M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    text: 'M5 6h14M5 12h14M5 18h9',
    url: 'M7 17 17 7M8 7h9v9',
    array: 'M8 5v14M16 5v14M5 8h14M5 16h14',
    select: 'M9 3.5h6a5.5 5.5 0 0 1 5.5 5.5v6a5.5 5.5 0 0 1-5.5 5.5H9a5.5 5.5 0 0 1-5.5-5.5V9A5.5 5.5 0 0 1 9 3.5ZM9 10.5l3 3 3-3',
    image: 'M21.6799 16.9599 18.5499 9.64988C17.4899 7.16988 15.5399 7.06988 14.2299 9.42988L12.3399 12.8399C11.3799 14.5699 9.58993 14.7199 8.34993 13.1699L8.12993 12.8899C6.83993 11.2699 5.01993 11.4699 4.08993 13.3199L2.36993 16.7699C1.15993 19.1699 2.90993 21.9999 5.58993 21.9999H18.3499C20.9499 21.9999 22.6999 19.3499 21.6799 16.9599ZM6.96997 8C8.62682 8 9.96997 6.65685 9.96997 5S8.62682 2 6.96997 2 3.96997 3.34315 3.96997 5 5.31312 8 6.96997 8Z',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 10h.01M15 10h.01M8.5 14a5 5 0 0 0 7 0',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[kind]);
  if (kind === 'image') {
    path.setAttribute('transform', 'matrix(0.85 0 0 0.85 1.8 1.8)');
    path.setAttribute('stroke-width', '2.12');
  }
  svg.append(path);
  svg.style.width = '18px';
  svg.style.height = '18px';
  svg.style.fill = 'none';
  svg.style.stroke = 'currentColor';
  svg.style.strokeLinecap = 'round';
  svg.style.strokeLinejoin = 'round';
  svg.style.strokeWidth = '1.8';
  return stylePropertyTypeSvgIcon(svg);
}

function createNotePropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');

  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('transform', 'matrix(0.85 0 0 0.85 0.95 1.8)');

  const page = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  page.setAttribute('d', 'M 3.6667 19 V 5 c 0 -1.4733 1.1933 -2.6667 2.6667 -2.6667 h 7.448 c 0.3533 0 0.6933 0.14 0.9427 0.3907 l 5.2187 5.2187 c 0.2507 0.2507 0.3907 0.5893 0.3907 0.9427 v 10.1146 c 0 1.4733 -1.1933 2.6667 -2.6667 2.6667 H 6.3333 c -1.4733 0 -2.6667 -1.1933 -2.6667 -2.6667 Z');
  page.setAttribute('stroke-width', '2.12');
  const foldedCorner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  foldedCorner.setAttribute('d', 'M 20.2133 8.3333 h -4.5467 c -0.736 0 -1.3333 -0.5973 -1.3333 -1.3333 V 2.4693');
  foldedCorner.setAttribute('stroke-width', '2.12');
  group.append(page, foldedCorner);
  svg.append(group);
  return svg;
}

function stylePropertyTypeSvgIcon(svg: SVGSVGElement): SVGSVGElement {
  svg.style.width = '18px';
  svg.style.height = '18px';
  svg.style.fill = 'none';
  svg.style.stroke = 'currentColor';
  svg.style.strokeLinecap = 'round';
  svg.style.strokeLinejoin = 'round';
  svg.style.strokeWidth = '1.8';
  return svg;
}

function createDatePropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');

  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outer.setAttribute('d', 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z');

  const days = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  days.setAttribute('d', 'M9 13.6h5.6');
  days.setAttribute('stroke-width', '1.8');

  const bindings = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bindings.setAttribute('d', 'M8 3v4M16 3v4');
  bindings.setAttribute('stroke-width', '1.3');

  svg.append(outer, bindings, days);
  return svg;
}

function createBooleanPropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');

  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lines.setAttribute('d', 'M13 7h8M13 17h8');

  const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  check.setAttribute('d', 'm3 17 2 2 4-4');

  const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  box.setAttribute('x', '3');
  box.setAttribute('y', '4');
  box.setAttribute('width', '6');
  box.setAttribute('height', '6');
  box.setAttribute('rx', '1');

  svg.append(lines, check, box);
  return svg;
}

function createColorPropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon', 'frontmatter-property__svg-icon--color');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('stroke', 'none');
  path.setAttribute('d', 'M200.77,53.89A103.27,103.27,0,0,0,128,24h-1.07A104,104,0,0,0,24,128c0,43,26.58,79.06,69.36,94.17A32,32,0,0,0,136,192a16,16,0,0,1,16-16h46.21a31.81,31.81,0,0,0,31.2-24.88,104.43,104.43,0,0,0,2.59-24A103.28,103.28,0,0,0,200.77,53.89Zm13,93.71A15.89,15.89,0,0,1,198.21,160H152a32,32,0,0,0-32,32,16,16,0,0,1-21.31,15.07C62.49,194.3,40,164,40,128a88,88,0,0,1,87.09-88h.9a88.35,88.35,0,0,1,88,87.25A88.86,88.86,0,0,1,213.81,147.6ZM140,76a12,12,0,1,1-12-12A12,12,0,0,1,140,76ZM96,100A12,12,0,1,1,84,88,12,12,0,0,1,96,100Zm0,56a12,12,0,1,1-12-12A12,12,0,0,1,96,156Zm88-56a12,12,0,1,1-12-12A12,12,0,0,1,184,100Z');
  svg.append(path);
  return svg;
}

function createNumberPropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon', 'frontmatter-property__svg-icon--number');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6.8 19V6.4c0-1.25 1.35-1.6 2-.6L15 18.2c.7 1 2 .7 2-.6V5.1');
  svg.append(path);
  return svg;
}
