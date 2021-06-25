// +build integration

package sqlstore

import (
	"reflect"
	"testing"

	"github.com/grafana/grafana/pkg/components/simplejson"
	"github.com/grafana/grafana/pkg/models"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/stretchr/testify/require"
)

func updateTestDashboard(t *testing.T, sqlStore *SQLStore, dashboard *models.Dashboard, data map[string]interface{}) {
	t.Helper()

	data["id"] = dashboard.Id

	saveCmd := models.SaveDashboardCommand{
		OrgId:     dashboard.OrgId,
		Overwrite: true,
		Dashboard: simplejson.NewFromAny(data),
	}
	_, err := sqlStore.SaveDashboard(saveCmd)
	require.NoError(t, err)
}

func TestGetDashboardVersion(t *testing.T) {
	t.Run("Testing dashboard version retrieval", func(t *testing.T) {
		sqlStore := InitTestDB(t)

		t.Run("Get a Dashboard ID and version ID", func(t *testing.T) {
			savedDash := insertTestDashboard(t, sqlStore, "test dash 26", 1, 0, false, "diff")

			query := models.GetDashboardVersionQuery{
				DashboardId: savedDash.Id,
				Version:     savedDash.Version,
				OrgId:       1,
			}

			err := GetDashboardVersion(&query)
			require.NoError(t, err)
			require.Equal(t, query.DashboardId, savedDash.Id)
			require.Equal(t, query.Version, savedDash.Version)

			dashCmd := models.GetDashboardQuery{
				OrgId: savedDash.OrgId,
				Uid:   savedDash.Uid,
			}

			err = GetDashboard(&dashCmd)
			require.NoError(t, err)
			eq := reflect.DeepEqual(dashCmd.Result.Data, query.Result.Data)
			require.Equal(t, true, eq)
		})

		t.Run("Attempt to get a version that doesn't exist", func(t *testing.T) {
			query := models.GetDashboardVersionQuery{
				DashboardId: int64(999),
				Version:     123,
				OrgId:       1,
			}

			err := GetDashboardVersion(&query)
			require.Error(t, err)
			require.Equal(t, models.ErrDashboardVersionNotFound, err)
		})
	})
}

func TestGetDashboardVersions(t *testing.T) {
	t.Run("Testing dashboard versions retrieval", func(t *testing.T) {
		sqlStore := InitTestDB(t)
		savedDash := insertTestDashboard(t, sqlStore, "test dash 43", 1, 0, false, "diff-all")

		t.Run("Get all versions for a given Dashboard ID", func(t *testing.T) {
			query := models.GetDashboardVersionsQuery{DashboardId: savedDash.Id, OrgId: 1}

			err := GetDashboardVersions(&query)
			require.NoError(t, err)
			require.Equal(t, 1, len(query.Result))
		})

		t.Run("Attempt to get the versions for a non-existent Dashboard ID", func(t *testing.T) {
			query := models.GetDashboardVersionsQuery{DashboardId: int64(999), OrgId: 1}

			err := GetDashboardVersions(&query)
			require.Error(t, err)
			require.Equal(t, models.ErrNoVersionsForDashboardId, err)
			require.Equal(t, 0, len(query.Result))
		})

		t.Run("Get all versions for an updated dashboard", func(t *testing.T) {
			updateTestDashboard(t, sqlStore, savedDash, map[string]interface{}{
				"tags": "different-tag",
			})

			query := models.GetDashboardVersionsQuery{DashboardId: savedDash.Id, OrgId: 1}
			err := GetDashboardVersions(&query)

			require.NoError(t, err)
			require.Equal(t, 2, len(query.Result))
		})
	})
}

func TestDeleteExpiredVersions(t *testing.T) {
	t.Run("Testing dashboard versions clean up", func(t *testing.T) {
		sqlStore := InitTestDB(t)
		versionsToKeep := 5
		versionsToWrite := 10
		setting.DashboardVersionsToKeep = versionsToKeep

		savedDash := insertTestDashboard(t, sqlStore, "test dash 53", 1, 0, false, "diff-all")
		for i := 0; i < versionsToWrite-1; i++ {
			updateTestDashboard(t, sqlStore, savedDash, map[string]interface{}{
				"tags": "different-tag",
			})
		}

		t.Run("Clean up old dashboard versions", func(t *testing.T) {
			err := DeleteExpiredVersions(&models.DeleteExpiredVersionsCommand{})
			require.NoError(t, err)

			query := models.GetDashboardVersionsQuery{DashboardId: savedDash.Id, OrgId: 1}
			err = GetDashboardVersions(&query)
			require.NoError(t, err)

			require.Equal(t, versionsToKeep, len(query.Result))
			// Ensure latest versions were kept
			require.Equal(t, versionsToWrite-versionsToKeep+1, query.Result[versionsToKeep-1].Version)
			require.Equal(t, versionsToWrite, query.Result[0].Version)
		})

		t.Run("Don't delete anything if there are no expired versions", func(t *testing.T) {
			setting.DashboardVersionsToKeep = versionsToWrite

			err := DeleteExpiredVersions(&models.DeleteExpiredVersionsCommand{})
			require.NoError(t, err)

			query := models.GetDashboardVersionsQuery{DashboardId: savedDash.Id, OrgId: 1, Limit: versionsToWrite}
			err = GetDashboardVersions(&query)
			require.NoError(t, err)

			require.Equal(t, versionsToWrite, len(query.Result))
		})

		t.Run("Don't delete more than MAX_VERSIONS_TO_DELETE_PER_BATCH * MAX_VERSION_DELETION_BATCHES per iteration", func(t *testing.T) {
			perBatch := 10
			maxBatches := 10

			versionsToWriteBigNumber := perBatch*maxBatches + versionsToWrite
			for i := 0; i < versionsToWriteBigNumber-versionsToWrite; i++ {
				updateTestDashboard(t, sqlStore, savedDash, map[string]interface{}{
					"tags": "different-tag",
				})
			}

			err := deleteExpiredVersions(&models.DeleteExpiredVersionsCommand{}, perBatch, maxBatches)
			require.NoError(t, err)

			query := models.GetDashboardVersionsQuery{DashboardId: savedDash.Id, OrgId: 1, Limit: versionsToWriteBigNumber}
			err = GetDashboardVersions(&query)
			require.NoError(t, err)

			// Ensure we have at least versionsToKeep versions
			So(len(query.Result), ShouldBeGreaterThanOrEqualTo, versionsToKeep)
			// Ensure we haven't deleted more than perBatch * maxBatches rows
			require.LessOrEqual(t, versionsToWriteBigNumber-len(query.Result), perBatch*maxBatches)
		})
	})
}
