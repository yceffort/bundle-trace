export default async function ({page}) {
  await page.getByRole('searchbox', {name: 'Search orders'}).fill('grace')
  await page.getByTestId('results').getByText('Grace Hopper').waitFor()
}
