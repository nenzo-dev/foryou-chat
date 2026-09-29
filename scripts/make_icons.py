from PIL import Image
import os

src = os.path.join(os.path.dirname(__file__), '..', 'icons', 'logo.webp')
out_dir = os.path.join(os.path.dirname(__file__), '..', 'icons')

img = Image.open(src).convert('RGBA')

def save_square(size, path):
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(path, 'PNG')

def save_maskable(size, path):
    # Maskable icons need ~20% safe-zone padding on each side so Android's
    # shape mask (circle/squircle/etc) doesn't crop the logo itself.
    inner = int(size * 0.6)
    resized = img.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (10, 10, 11, 255))  # matches manifest background_color
    offset = (size - inner) // 2
    canvas.paste(resized, (offset, offset), resized)
    canvas.save(path, 'PNG')

save_square(192, os.path.join(out_dir, 'icon-192.png'))
save_square(512, os.path.join(out_dir, 'icon-512.png'))
save_maskable(512, os.path.join(out_dir, 'icon-maskable-512.png'))
print('done')
