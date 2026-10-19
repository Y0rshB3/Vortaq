import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, imageFileBytes, imageFileName, imageSavePath } from './imageExport'

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest')
]).toString('base64')

describe('diagram image export', () => {
  it('writes a real PNG or an SVG document, nothing else', () => {
    expect(imageFileBytes({ format: 'png', data: png }).subarray(1, 4).toString()).toBe('PNG')
    expect(imageFileBytes({ format: 'svg', data: '<svg xmlns="x"></svg>' }).toString()).toBe(
      '<svg xmlns="x"></svg>'
    )
    expect(imageFileBytes({ format: 'svg', data: '<?xml version="1.0"?>\n<svg/>' })).toBeTruthy()
    expect(() =>
      imageFileBytes({ format: 'png', data: Buffer.from('GIF89a').toString('base64') })
    ).toThrow('La imagen PNG no es válida.')
    expect(() => imageFileBytes({ format: 'png', data: 'not base64!' })).toThrow(/no es válida/)
    expect(() => imageFileBytes({ format: 'svg', data: '<html></html>' })).toThrow(
      'El SVG no es válido.'
    )
    expect(() => imageFileBytes({ format: 'exe', data: 'MZ' })).toThrow(
      /Formato de imagen no admitido/
    )
    expect(() => imageFileBytes(null)).toThrow('Imagen no válida.')
    expect(() =>
      imageFileBytes({ format: 'svg', data: `<svg>${'x'.repeat(MAX_IMAGE_BYTES)}</svg>` })
    ).toThrow(/demasiado grande/)
  })

  it('suggests a safe file name and keeps the extension', () => {
    expect(imageFileName('ventas/../x: "a"', 'png')).toBe('ventas_.._x_ _a_.png')
    expect(imageFileName('tienda.svg', 'svg')).toBe('tienda.svg')
    expect(imageFileName('   ', 'png')).toBe('diagrama.png')
    expect(imageSavePath('/tmp/diagrama', 'png')).toBe('/tmp/diagrama.png')
    expect(imageSavePath('/tmp/d.PNG', 'png')).toBe('/tmp/d.PNG')
  })
})
