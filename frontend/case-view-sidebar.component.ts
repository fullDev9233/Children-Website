import { Component, ChangeDetectorRef, OnInit, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { Subject, Observable } from 'rxjs';
import { takeUntil, map } from 'rxjs/operators';
import { Apollo } from 'apollo-angular';
import { faFile, faFileAlt, faPhone, faEnvelope, faLink, faHashtag, faPencilAlt, IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { BsModalService } from 'ngx-bootstrap';

import { PermissionService } from '../../../shared/services/permission.service';
import { MixpanelService } from '../../../shared/services/mixpanel.service';
import { CASE_DETAIL_QUERY } from '../../fragments/cases';
import { ENGAGEMENTS_COUNTS_QUERY } from '../../fragments/engagement';
import { Roles, EngagementDataType } from '../../../../generated/globalTypes';
import { CaseDetail } from '../../../../generated/CaseDetail';
import { caseDetails, caseDetailsVariables } from '../../../../generated/caseDetails';
import { engagementCounts_engagementCounts, engagementCounts, engagementCountsVariables } from '../../../../generated/engagementCounts';

import {
  RequestCaseEditorAccess,
  RequestCaseEditorAccessModalComponent,
} from '../request-case-editor-access-modal/request-case-editor-access-modal.component';

interface EngagementStatistic {
  count: number;
  name: string;
  icon: IconDefinition;
}

interface EngagementStatistics {
  totalCount: number;
  engagements: EngagementStatistic[];
}

function getEngagementStatistic(
  counts: engagementCounts_engagementCounts[],
  type: EngagementDataType,
  name: string,
  icon: IconDefinition
): EngagementStatistic {
  const engagement = counts.find((c) => c.type === type);
  const count = engagement ? engagement.count : 0;
  return {
    name: name + (count === 1 ? '' : 's'),
    icon,
    count,
  };
}

enum Tab {
  ENGAGEMENT = 'Engagement',
  PERMISSION = 'Permission',
  HIGHLIGHT = 'Highlight',
}

@Component({
  selector: 'cok-case-view-sidebar',
  templateUrl: './case-view-sidebar.component.html',
  styleUrls: ['./case-view-sidebar.component.scss'],
})
export class CaseViewSidebarComponent implements OnInit, OnDestroy, RequestCaseEditorAccess {
  public roles = Roles;
  public tabs = Tab;
  public shorter: boolean = false;
  public faLink = faLink;
  public faHashtag = faHashtag;
  public faPencilAlt = faPencilAlt;

  // set from input data
  public insideBuilder: boolean = false;
  public caseId: number;

  private _activeTab: Tab = Tab.ENGAGEMENT;
  public get activeTab() {
    return this._activeTab;
  }

  public set activeTab(tab: Tab) {
    this._activeTab = tab;
    this.mixpanelService.trackAction('open-case-viewer-sidebar', {
      CaseId: this.caseId,
      Tab: this.activeTab,
    });
  }

  public isEngagementStatisticsLoading = true;
  public engagementStatistics: EngagementStatistics | undefined;
  public relationshipsCount: number = 0;
  public caseChild$: Observable<CaseDetail>;

  private subscription = new Subject();

  constructor(
    private detector: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router,
    private ngxModalService: BsModalService,
    private permissionService: PermissionService,
    private mixpanelService: MixpanelService,
    private apollo: Apollo
  ) {}

  ngOnInit() {
    this.shorter = this.route.snapshot.data['shorter'];

    this.route.params.pipe(takeUntil(this.subscription)).subscribe((params) => {
      this.caseId = +params.id;
      this.activeTab = Tab.ENGAGEMENT;

      this.caseChild$ = this.apollo
        .watchQuery<caseDetails, caseDetailsVariables>({
          query: CASE_DETAIL_QUERY,
          variables: { caseId: +params.id },
        })
        .valueChanges.pipe(
          map((result) => {
            if (!result.data.case) {
              console.warn(`Failed to get case: ${+params.id}`);
              throw new Error(`Failed to get case: ${+params.id}`);
            }

            return result.data.case;
          })
        );

      if (this.activeTab === this.tabs.ENGAGEMENT) {
        this.isEngagementStatisticsLoading = true;

        this.apollo
          .watchQuery<engagementCounts, engagementCountsVariables>({
            query: ENGAGEMENTS_COUNTS_QUERY,
            variables: { caseId: +params.id },
          })
          .valueChanges.pipe(takeUntil(this.subscription))
          .subscribe(
            (result) => {
              const counts = result.data.engagementCounts;
              const stats: EngagementStatistics = {
                totalCount: 0,
                engagements: [
                  getEngagementStatistic(counts, EngagementDataType.N, 'Note', faFile),
                  getEngagementStatistic(counts, EngagementDataType.D, 'Document', faFileAlt),
                  getEngagementStatistic(counts, EngagementDataType.C, 'Phone Call', faPhone),
                  getEngagementStatistic(counts, EngagementDataType.E, 'Email', faEnvelope),
                ],
              };
              stats.totalCount = stats.engagements.map((e) => e.count).reduce((a, b) => a + b, 0);

              this.relationshipsCount = result.data.relationshipsCount;
              this.engagementStatistics = stats;
              this.isEngagementStatisticsLoading = false;
              this.detector.detectChanges();
            },
            (err) => {
              console.error(err);
              this.isEngagementStatisticsLoading = false;
              this.detector.detectChanges();
            }
          );
      }
    });

    this.insideBuilder = this.route.snapshot.data.insideBuilder ?? true;
  }

  ngOnDestroy() {
    this.subscription.next();
    this.subscription.complete();
  }

  public openEditForm() {
    this.router.navigate([{ outlets: { sidebar: null } }], { relativeTo: this.route.parent, replaceUrl: true });
    this.router.navigate([{ outlets: { sidebar: ['edit-case', this.caseId] } }], { relativeTo: this.route.parent, replaceUrl: true });
  }

  public workOnCaseClicked() {
    this.router.navigate(['cases', this.caseId]);
  }

  public hasRole(role: Roles) {
    return this.permissionService.hasRole(role, this.caseId);
  }

  public requestCaseEditorAccess(title: string = 'Unauthorized') {
    this.ngxModalService.show(RequestCaseEditorAccessModalComponent, {
      initialState: { title, caseId: this.caseId },
      class: 'modal-dialog-centered',
    });
  }

  public closeSidebar() {
    this.router.navigate([{ outlets: { sidebar: null } }], { relativeTo: this.route.parent });
  }
}
