#!/usr/bin/env python3
"""Écrans de lancement iOS (apple-touch-startup-image) de Kaamelott : K blanc centré sur noir.

Le K est le même tracé que celui de l'icône (que des segments droits) : on le dessine en polygone avec Pillow,
suréchantillonné 4x pour un anticrénelage propre. Le premier écran HTML utilise exactement le même tracé (SVG),
à la même taille (64 pt) et au même centre (centre de l'écran) : l'image et la page se superposent au pixel.

Usage : python3 generer_ecrans_lancement.py [dossier_sortie]   (défaut : ./splash)
Écrit les PNG + splash-links.html (les balises <link> à coller dans le <head> d'index.html).
"""
import sys, os
from PIL import Image, ImageDraw

# Tracé du K (repère de l'icône 512 : boîte x 175→350, y 152→360), identique au <path> du HTML
K = [(175, 152), (219, 152), (219, 245.5), (296.6, 152), (348, 152), (271.4, 244.4), (350, 360),
     (297, 360), (240.5, 273), (219, 299), (219, 360), (175, 360)]
KX0, KY0, KW, KH = 175, 152, 175, 208
K_PT = 64            # hauteur du K en points CSS (même valeur que .launch-k dans le CSS)
BG, FG = (0, 0, 0), (255, 255, 255)
SS = 4               # suréchantillonnage

# iPhone en portrait : (largeur pt, hauteur pt, échelle, modèles)
DEVICES = [
    (375, 667, 2, 'iPhone SE 2e/3e gén., 8, 7, 6s'),
    (414, 736, 3, 'iPhone 8 Plus, 7 Plus'),
    (375, 812, 3, 'iPhone X, XS, 11 Pro, 12 mini, 13 mini'),
    (414, 896, 2, 'iPhone XR, 11'),
    (414, 896, 3, 'iPhone XS Max, 11 Pro Max'),
    (390, 844, 3, 'iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e'),
    (428, 926, 3, 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus'),
    (393, 852, 3, 'iPhone 14 Pro, 15, 15 Pro, 16'),
    (430, 932, 3, 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus'),
    (402, 874, 3, 'iPhone 16 Pro, 17, 17 Pro'),
    (420, 912, 3, 'iPhone Air'),
    (440, 956, 3, 'iPhone 16 Pro Max, 17 Pro Max'),
]


def render(w_pt, h_pt, scale):
    W, H = w_pt * scale, h_pt * scale
    s = K_PT * scale / KH                      # px par unité du tracé
    cx, cy = W / 2, H / 2                      # centre du K = centre de l'écran
    img = Image.new('RGB', (W * SS, H * SS), BG)
    pts = [((cx + (x - KX0 - KW / 2) * s) * SS, (cy + (y - KY0 - KH / 2) * s) * SS) for x, y in K]
    ImageDraw.Draw(img).polygon(pts, fill=FG)
    return img.resize((W, H), Image.LANCZOS)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'splash'
    os.makedirs(out, exist_ok=True)
    links = []
    for w, h, sc, names in DEVICES:
        name = f'launch-{w * sc}x{h * sc}.png'
        render(w, h, sc).save(os.path.join(out, name), optimize=True)
        links.append(f'<!-- {names} -->\n<link rel="apple-touch-startup-image" href="/{os.path.basename(out)}/{name}" '
                     f'media="(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {sc}) '
                     f'and (orientation: portrait)">')
        print(f'{name:28} {names}')
    with open(os.path.join(out, 'splash-links.html'), 'w') as f:
        f.write('\n'.join(links) + '\n')
    print(f'\n{len(DEVICES)} images + splash-links.html dans {out}/')


if __name__ == '__main__':
    main()
