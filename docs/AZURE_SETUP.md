# Deploying on Azure DevOps

The Azure build does the same job as the GitHub one. It runs a nightly R build from NEMWeb, keeps a permanent copy of the fetched extracts, and publishes `site/`. Three pieces change:

| GitHub | Azure |
|---|---|
| `.github/workflows/pages.yml` | `azure-pipelines.yml` |
| GitHub release `data-aemo` (`scripts/release_sync.sh`) | Blob Storage container (`scripts/blob_sync.sh`), same file names and `manifest.tsv` |
| GitHub Pages | Azure Static Web Apps (`site/staticwebapp.config.json`) |

The R code and the front end are unchanged. The data is still served from `data/` on the same site, so `app.js` needs no edits.

## 1. Bring the code into Azure Repos

1. In Azure DevOps, go to **Repos > Import repository**.
2. Paste the GitHub repo URL. A public repo needs no credentials.

You can keep committing through the web UI, either by editing files or with **Upload file(s)**.

Alternatively, you can leave the code on GitHub and point the pipeline at it (**New pipeline > GitHub**). This needs the Azure Pipelines GitHub app.

## 2. Create the Azure resources

Do this in the Azure portal, in the Atmos subscription. IT may need to do this step for you.

1. **Resource group:** for example `rg-esem-dashboard` in Australia East.
2. **Storage account:**
   - Settings: StorageV2, LRS, blob anonymous access disabled.
   - Create a private container named `esem-data`. It will hold `aemo/nem_YYYYMM.rds`, `aemo/pd_YYYYMM.rds` and the other extracts, roughly 2–3 GB.
3. **Static Web App:**
   - Choose a plan:
     - **Free**: up to 250 MB per site and anyone with the link can open it.
     - **Standard**: about US$9 a month, up to 500 MB, and required for the Atmos-only sign-in in step 6.
   - Set **Deployment source** to **Other**.
   - After it is created, open **Overview > Manage deployment token** and copy the token.

## 3. Service connection (lets the pipeline use the storage account)

1. Go to **Project settings > Service connections > New > Azure Resource Manager > Workload identity federation (automatic)**.
2. Scope it to the resource group and name it **`esem-azure`**. If you use another name, change `serviceConnection` at the top of `azure-pipelines.yml`.
3. Grant data access to the storage account:
   1. Open **Storage account > Access control (IAM) > Add role assignment**.
   2. Choose **Storage Blob Data Contributor**.
   3. Select the service connection's identity as the member. Its name is under **Manage service principal** on the connection.

   This step is needed because resource-group *Contributor* does not grant read or write access to blob contents.

## 4. Variable group

Go to **Pipelines > Library > + Variable group** and name the group **`esem-dashboard`**.

| Variable | Value |
|---|---|
| `DATA_SOURCE` | `aemo` |
| `STORAGE_ACCOUNT` | storage account name |
| `STORAGE_CONTAINER` | `esem-data` |
| `SWA_DEPLOYMENT_TOKEN` | the token from step 2. Click the padlock to make it secret. |
| `GITHUB_REPO` | `owner/repo` of the GitHub repo. Only needed for the one-off seed in step 5. |
| optional: `START_YEAR`, `SHAPE_START_YEAR`, `YEARS_BACK` | same meaning as on GitHub |
| optional: `FETCH_MINUTES` | default 35, which fits the free 60-minute job. Use about 240 with a paid parallel job. |
| optional: `SWA_MAX_MB` | default 250 (Free). Set to 500 on Standard. |
| optional: `SWA_AUTH`, `ENTRA_TENANT_ID` | see step 6 |

## 5. Create and run the pipeline

1. Go to **Pipelines > New pipeline > Azure Repos Git**.
2. Pick the repo, then **Existing Azure Pipelines YAML file** > `/azure-pipelines.yml`.
3. Click **Run**. For the first run, open **Run pipeline**, tick **One-off – copy the GitHub data-aemo release into Blob Storage**, and run it.
   - This copies the existing extracts across, so the first build doesn't refetch years of NEMWeb data.
   - Approve the permission prompts for the variable group and service connection.
4. Find the site URL on **Static Web App > Overview**, for example `https://<name>.azurestaticapps.net`.

The pipeline then runs nightly at 06:15 AEST and on every push to `main` that touches the app.

Once the Azure build is working, stop the GitHub schedule in GitHub: **Actions > Build and deploy dashboard > ··· > Disable workflow**.

### Agent minutes

Check **Organization settings > Parallel jobs**.

- **Free tier:** one Microsoft-hosted job of up to 60 minutes and 1,800 minutes a month. That is enough for the nightly incremental build.
- **Large backfill on the free tier:** `FETCH_MINUTES` stops fetching in time to build. Each night continues where the last one stopped, because the extracts are saved to Blob Storage.
- **Paid parallel job:** raises the limit to 360 minutes per job.
- **New organisations:** may have to request the free grant before any hosted job runs.

### If NEMWeb is unreachable from Azure-hosted agents

The fetch report (`aemo/fetch_report.md` in the container) will show the failures. If that happens:

1. Register a self-hosted agent on an Atmos VM with Ubuntu, R, `r-cran-data.table`, `r-cran-jsonlite`, `unzip`, `jq` and the Azure CLI.
2. Enter its pool name in the **Self-hosted agent pool** run parameter.

## 6. Optional: Atmos-only sign-in (Entra ID)

This requires the Static Web App on the **Standard** plan.

1. **Entra ID > App registrations > New registration:**
   - Single tenant.
   - Redirect URI (Web): `https://<site-host>/.auth/login/aad/callback`.
   - Under **Authentication**, tick **ID tokens**.
   - Under **Certificates & secrets**, create a client secret.
2. **Static Web App > Settings > Environment variables:** add `AZURE_CLIENT_ID` (the application ID) and `AZURE_CLIENT_SECRET`.
3. **Variable group:** set `SWA_AUTH` = `entra`, `ENTRA_TENANT_ID` = the Atmos tenant ID, and `SWA_MAX_MB` = `500`.

On the next run, the pipeline installs `config/staticwebapp.entra.json` as the site config. Every page and data file then requires an Atmos sign-in.

## Size check

The pipeline fails before deploying if `site/` is larger than `SWA_MAX_MB`. That is clearer than a rejected upload.

The synthetic build is about 183 MB. A full AEMO build is larger, so if it exceeds 250 MB, move to Standard (500 MB) or narrow `START_YEAR` / `YEARS_BACK`.
