import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountComponent, setupDom } from '../../views/__tests__/helpers'
import EnumInput from './EnumInput.vue'

type Wrapper = Awaited<ReturnType<typeof mountComponent>>

const options = ['Active', 'Archived', 'Inactive']
const list = () => document.body.querySelector<HTMLElement>('[data-test="enum-list"]')
const labels = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map((o) =>
    o.textContent?.trim()
  )
const highlighted = () =>
  document.body.querySelector<HTMLElement>('[role="option"].is-highlighted')?.textContent?.trim()

describe('EnumInput', () => {
  let wrapper: Wrapper | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => wrapper?.unmount())

  async function mount(modelValue = 'Active', extra: Record<string, unknown> = {}) {
    wrapper?.unmount()
    wrapper = await mountComponent(
      EnumInput,
      {
        modelValue,
        options,
        label: 'Editar status',
        autofocus: true,
        'onUpdate:modelValue': (v: string) => wrapper?.setProps({ modelValue: v }),
        ...extra
      },
      setupDom()
    )
    return wrapper
  }
  const emitted = (w: Wrapper, name: string) => (w.emitted(name) ?? []) as unknown[][]

  it('opens with every value listed and the current one highlighted', async () => {
    const w = await mount('Archived')
    expect(list()).not.toBeNull()
    expect(labels()).toEqual(options)
    expect(highlighted()).toBe('Archived')
    expect(w.get('input').attributes('aria-expanded')).toBe('true')
  })

  it('typing narrows the list (starting with the text first) and Enter writes the highlighted value', async () => {
    const w = await mount()
    const input = w.get('input')
    await input.setValue('act')
    expect(labels()).toEqual(['Active', 'Inactive'])
    expect(highlighted()).toBe('Active')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(highlighted()).toBe('Inactive')
    await input.trigger('keydown', { key: 'Enter' })
    expect(emitted(w, 'commit')).toEqual([['Inactive']])
    expect(list()).toBeNull()
  })

  it('a click on a value writes it; focus never leaves the field', async () => {
    const w = await mount()
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')][1]
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()
    expect(emitted(w, 'commit')).toEqual([['Archived']])
  })

  it('leaving untouched closes without writing (a NULL cell stays NULL)', async () => {
    const w = await mount('', { nullable: true })
    await w.get('input').trigger('blur')
    expect(emitted(w, 'leave')).toHaveLength(1)
    const editor = w.vm as unknown as { tryCommit: () => boolean }
    expect(editor.tryCommit()).toBe(true)
    expect(emitted(w, 'commit')).toEqual([])
    expect(emitted(w, 'cancel')).toHaveLength(1)
  })

  it('accepts exactly one value ignoring case; any other text shows an error and is not written', async () => {
    const w = await mount()
    const editor = w.vm as unknown as { tryCommit: () => boolean; open: boolean }
    await w.get('input').setValue('zzz')
    expect(labels()).toEqual([])
    expect(document.body.querySelector('[data-test="enum-empty"]')?.textContent).toMatch(
      /Ningún valor coincide/
    )
    expect(editor.tryCommit()).toBe(false)
    await w.vm.$nextTick()
    expect(w.get('[data-test="enum-error"]').text()).toBe(
      '«zzz» no es uno de los valores permitidos'
    )
    expect(emitted(w, 'commit')).toEqual([])
    await w.get('input').setValue('archived')
    await w.get('input').trigger('keydown', { key: 'Escape' })
    expect(list()).toBeNull()
    expect(editor.tryCommit()).toBe(true)
    expect(emitted(w, 'commit')).toEqual([['Archived']])
  })

  it('offers NULL first on a nullable column; Escape closes the list, then cancels', async () => {
    const w = await mount('Active', { nullable: true })
    expect(labels()).toEqual(['NULL', ...options])
    await w.get('input').setValue('nu')
    expect(labels()).toEqual(['NULL'])
    await w.get('input').trigger('keydown', { key: 'Enter' })
    expect(emitted(w, 'commit')).toEqual([[null]])

    const other = await mount('Active')
    expect(labels()).toEqual(options)
    await other.get('input').trigger('keydown', { key: 'Escape' })
    expect(list()).toBeNull()
    expect(emitted(other, 'cancel')).toEqual([])
    await other.get('input').trigger('keydown', { key: 'Escape' })
    expect(emitted(other, 'cancel')).toHaveLength(1)
  })

  it('↑/↓ without typing, then leaving, writes the highlighted value; Tab goes to the host', async () => {
    const w = await mount('Active')
    await w.get('input').trigger('keydown', { key: 'ArrowDown' })
    expect(highlighted()).toBe('Archived')
    const editor = w.vm as unknown as { tryCommit: () => boolean }
    expect(editor.tryCommit()).toBe(true)
    expect(emitted(w, 'commit')).toEqual([['Archived']])
    await w.get('input').trigger('keydown', { key: 'Tab' })
    expect(emitted(w, 'keydown')).toHaveLength(1)
  })
})
