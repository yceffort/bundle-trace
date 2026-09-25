export default async function ({page}) {
  await page.getByRole('button', {name: 'Open report'}).click()
  await page.getByRole('img', {name: 'Weekly orders'}).waitFor()
}
