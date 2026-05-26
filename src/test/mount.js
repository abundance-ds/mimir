import { mount, shallowMount } from '@vue/test-utils'

export function mountWith(component, { props, provide, shallow = false } = {}) {
  const fn = shallow ? shallowMount : mount
  return fn(component, {
    props,
    global: provide ? { provide } : undefined,
  })
}
