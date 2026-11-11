import { afterEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { sshChangedHostMessage, sshUnknownHostMessage } from '@shared/sshHostKey'
import type { ConnectionInput } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from './ConnectionDialog.vue'
import { freshPinia, makeConnection, mockVortaq, mountWith, settle } from './testing'

const FP = 'SHA256:I3agu1Hn5jip3mSooabPbauC1z2hLi6VNbXNqrmlRX8'
const NEW_FP = `SHA256:${'B'.repeat(43)}`

describe('ConnectionDialog · SSH host key', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null
  afterEach(() => wrapper?.unmount())

  const ssh = {
    enabled: true,
    host: 'bastion.example',
    port: 22,
    username: 'ana',
    authType: 'password' as const,
    savePassword: true
  }

  async function openEditing(
    connection: ReturnType<typeof makeConnection>,
    test: (input: ConnectionInput) => unknown
  ): Promise<void> {
    invoke = mockVortaq({
      'connections:list': () => [connection],
      'connections:hasPassword': () => true,
      'connections:hasSshPassword': () => true,
      'connections:hasSslKeyPassword': () => false,
      'connections:test': (input: unknown) => test(input as ConnectionInput)
    })
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: connection, engine: connection.engine }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
  }
  const testCalls = (): ConnectionInput[] =>
    invoke.mock.calls.filter((c) => c[0] === 'connections:test').map((c) => c[1] as ConnectionInput)

  it('a server not confirmed yet: shows its fingerprint and «Confiar y reintentar» pins it', async () => {
    await openEditing(makeConnection({ id: 'c', name: 'Tienda', ssh }), (input) =>
      input.ssh.hostKey === FP
        ? { ok: true, durationMs: 9, serverVersion: '8.4.7' }
        : { ok: false, durationMs: 5, error: sshUnknownHostMessage('bastion.example', 22, FP) }
    )
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(wrapper!.get('[data-test="conn-ssh-hostkey-offer"]').text()).toContain(FP)
    await wrapper!.get('[data-test="conn-ssh-hostkey-trust"]').trigger('click')
    await settle()
    expect(testCalls().map((c) => c.ssh.hostKey)).toEqual([undefined, FP])
    expect(wrapper!.find('[data-test="conn-ssh-hostkey-offer"]').exists()).toBe(false)
    // Saved with the form.
    expect((wrapper!.vm as unknown as { form: ConnectionInput }).form.ssh.hostKey).toBe(FP)
  })

  it('a changed key is refused; «Olvidar la huella guardada» drops it so the new one is confirmed again', async () => {
    await openEditing(
      makeConnection({ id: 'c', name: 'Tienda', ssh: { ...ssh, hostKey: FP } }),
      (input) => ({
        ok: false,
        durationMs: 5,
        error: input.ssh.hostKey
          ? sshChangedHostMessage('bastion.example', 22, FP, NEW_FP)
          : sshUnknownHostMessage('bastion.example', 22, NEW_FP)
      })
    )
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(wrapper!.find('[data-test="conn-ssh-hostkey-changed"]').exists()).toBe(true)
    // Never a «Confiar» for a changed key.
    expect(wrapper!.find('[data-test="conn-ssh-hostkey-trust"]').exists()).toBe(false)
    await wrapper!.get('[data-test="conn-ssh-hostkey-forget-changed"]').trigger('click')
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(testCalls().map((c) => c.ssh.hostKey)).toEqual([FP, undefined])
    expect(wrapper!.get('[data-test="conn-ssh-hostkey-offer"]').text()).toContain(NEW_FP)
  })

  it('the pinned key belongs to its SSH host and port: changing them drops it, opening the form does not', async () => {
    await openEditing(
      makeConnection({ id: 'c', name: 'Tienda', ssh: { ...ssh, hostKey: FP } }),
      () => ({
        ok: true,
        durationMs: 1
      })
    )
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(testCalls()[0].ssh.hostKey).toBe(FP)
    const vm = wrapper!.vm as unknown as { form: ConnectionInput }
    vm.form = { ...vm.form, ssh: { ...vm.form.ssh, host: 'otro-bastion.example' } }
    await settle()
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(testCalls()[1].ssh.hostKey).toBeUndefined()
  })
})
