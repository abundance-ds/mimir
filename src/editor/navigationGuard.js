// Text and Graph open commands share one order with tab navigation.
export function createNavigationGuard() {
  let generation = 0
  return {
    begin() {
      const request = ++generation
      return () => request === generation
    },
    cancel() { generation += 1 },
  }
}
