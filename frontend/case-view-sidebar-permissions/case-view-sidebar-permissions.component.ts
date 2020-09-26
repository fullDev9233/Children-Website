import { Component, ChangeDetectorRef, Input, OnDestroy, OnInit, TemplateRef } from '@angular/core';
import { FormGroup, FormBuilder, Validators, AbstractControl, FormControl } from '@angular/forms';
import { Subject, combineLatest, BehaviorSubject, Observable, EMPTY, of } from 'rxjs';
import { takeUntil, map, finalize, switchMap } from 'rxjs/operators';
import { ToastrService } from 'ngx-toastr';
import { DataProxy } from 'apollo-cache';
import { Apollo } from 'apollo-angular';
import { ApolloError } from 'apollo-client';
import { BsModalRef, BsModalService } from 'ngx-bootstrap';
import gql from 'graphql-tag';

import { Validator } from '../../../../shared/utilities/validator.form-control';
import { PermissionService, roleLevel } from '../../../../shared/services/permission.service';
import { MixpanelService } from '../../../../shared/services/mixpanel.service';
import { USERS_QUERY, USER_INFO_FRAGMENT, UserService } from '../../../../auth0/services/user.service';
import { Roles } from '../../../../../generated/globalTypes';
import { CaseDetail } from '../../../../../generated/CaseDetail';
import {
  caseSidebarCaseRolesVariables,
  caseSidebarCaseRoles,
  caseSidebarCaseRoles_caseRoles,
} from '../../../../../generated/caseSidebarCaseRoles';
import { caseSidebarRemoveCaseRoleVariables, caseSidebarRemoveCaseRole } from '../../../../../generated/caseSidebarRemoveCaseRole';
import { getUsers } from '../../../../../generated/getUsers';
import { UserInfo } from '../../../../../generated/UserInfo';
import { caseSidebarEditCaseRole, caseSidebarEditCaseRoleVariables } from '../../../../../generated/caseSidebarEditCaseRole';
import { CaseSidebarCaseRole } from '../../../../../generated/CaseSidebarCaseRole';
import { caseSidebarInviteUserVariables, caseSidebarInviteUser } from '../../../../../generated/caseSidebarInviteUser';

const CASE_SIDEBAR_CASE_ROLE_FRAGMENT = gql`
  fragment CaseSidebarCaseRole on CaseRole {
    id
    user {
      ...UserInfo
    }
    role
  }
`;

const CASE_SIDEBAR_CASE_ROLES_QUERY = gql`
  query caseSidebarCaseRoles($caseId: Int!) {
    caseRoles(caseId: $caseId) {
      ...CaseSidebarCaseRole
    }
  }
  ${USER_INFO_FRAGMENT}
  ${CASE_SIDEBAR_CASE_ROLE_FRAGMENT}
`;

const INVITE_USER_MUTATION = gql`
  mutation caseSidebarInviteUser($caseId: Int!, $user: CreateNoPermissionUserInput!) {
    createNoPermissionUser(caseId: $caseId, value: $user) {
      ...UserInfo
    }
  }
  ${USER_INFO_FRAGMENT}
`;

export function setCaseRolesCache(caseId: number, caseRoles: caseSidebarCaseRoles_caseRoles[], cache: DataProxy) {
  cache.writeQuery<caseSidebarCaseRoles, caseSidebarCaseRolesVariables>({
    query: CASE_SIDEBAR_CASE_ROLES_QUERY,
    variables: { caseId },
    data: { caseRoles },
  });
}

function refetchMe(updatedUserId: number, myUserId: number | undefined): string[] {
  return updatedUserId === myUserId ? ['getMe'] : [];
}

@Component({
  selector: 'cok-case-view-sidebar-permissions',
  templateUrl: './case-view-sidebar-permissions.component.html',
  styleUrls: ['./case-view-sidebar-permissions.component.scss'],
})
export class CaseViewSidebarPermissionsComponent implements OnInit, OnDestroy {
  @Input()
  caseChild: CaseDetail;

  public inviteForm: FormGroup;

  private subscription = new Subject();
  private myUserId: number | undefined;

  public roles = Roles;
  public loading = new BehaviorSubject(true);
  public teamName: string;
  public userCaseRoles = new Map<number, CaseSidebarCaseRole>(); // map of user id to case role associated with caseId

  public users$: Observable<UserInfo[]> = EMPTY;
  public caseUsers: UserInfo[] = []; // users who have team or case level permissions to interact with case
  public allUsers: UserInfo[] = []; // users who have no permissions to interact with case
  public userByEmail = new Map<string, UserInfo>();

  public addMemberSelectedUser: UserInfo | undefined;

  public modalRef: BsModalRef | undefined;

  public currentUserId?: number;

  constructor(
    private formBuilder: FormBuilder,
    private detector: ChangeDetectorRef,
    private messageService: ToastrService,
    private permissionService: PermissionService,
    private apollo: Apollo,
    private mixpanelService: MixpanelService,
    private modalService: BsModalService,
    userService: UserService
  ) {
    this.myUserId = userService.currentUser?.id;
    this.teamName = userService.currentUser?.userTeam?.team.name || '';
    this.currentUserId = userService.currentUser?.id;
  }

  ngOnInit() {
    this.users$ = this.apollo
      .watchQuery<getUsers>({ query: USERS_QUERY })
      .valueChanges.pipe(
        map((result) =>
          result.data.users.sort((a, b) => {
            const nameCompare = a.name.localeCompare(b.name);
            if (nameCompare !== 0) return nameCompare;

            return a.id - b.id;
          })
        )
      );

    const caseRoles$: Observable<CaseSidebarCaseRole[]> = this.apollo
      .watchQuery<caseSidebarCaseRoles, caseSidebarCaseRolesVariables>({
        query: CASE_SIDEBAR_CASE_ROLES_QUERY,
        variables: { caseId: this.caseChild.id },
      })
      .valueChanges.pipe(map((result) => result.data.caseRoles));

    combineLatest(this.users$, caseRoles$)
      .pipe(takeUntil(this.subscription))
      .subscribe(([users, caseRoles]) => {
        this.loading.next(false);

        this.allUsers = users;
        this.userByEmail = new Map(users.map((u) => [u.email.trim().toLocaleLowerCase(), u]));

        this.userCaseRoles = new Map(caseRoles.map((c) => [c.user.id, c]));

        const usersWithCasePermissions = new Set([
          ...users.filter((u) => u.userTeam?.role !== undefined && roleLevel(u.userTeam.role) >= roleLevel(Roles.VIEWER)).map((u) => u.id),
          ...caseRoles.map((c) => c.user.id),
        ]);
        this.caseUsers = users.filter((u) => usersWithCasePermissions.has(u.id));

        this.detector.detectChanges();
      });
  }

  ngOnDestroy() {
    this.subscription.next();
    this.subscription.complete();
  }

  openAddTeamMemberModal(template: TemplateRef<any>) {
    this.isInviteBusy = false;
    this.isInviteSubmitted = false;
    this.inviteCaseRole = Roles.VIEWER;

    this.inviteForm = this.formBuilder.group(
      {
        firstName: [null, Validators.required],
        lastName: [null, Validators.required],
        email: [null, [Validators.required, Validator.email]],
      },
      { updateOn: 'blur' }
    );

    this.modalRef = this.modalService.show(template, { class: 'modal-dialog-centered' });
  }

  private mutateCaseRole(userId: number, role: Roles) {
    return this.apollo.mutate<caseSidebarEditCaseRole, caseSidebarEditCaseRoleVariables>({
      mutation: gql`
        mutation caseSidebarEditCaseRole($caseId: Int!, $userId: Int!, $role: Roles!) {
          addCaseRole(caseId: $caseId, userId: $userId, role: $role) {
            ...CaseSidebarCaseRole
          }
        }
        ${USER_INFO_FRAGMENT}
        ${CASE_SIDEBAR_CASE_ROLE_FRAGMENT}
      `,
      variables: { caseId: this.caseChild.id, userId, role },
      update: (cache, result) => {
        if (result.data) {
          setCaseRolesCache(this.caseChild.id, result.data.addCaseRole, cache);
        }
      },
      refetchQueries: () => [...refetchMe(userId, this.myUserId), 'casesContributors'],
    });
  }

  private addCaseRole(user: UserInfo, role: Roles) {
    const context = {
      CaseId: this.caseChild.id,
      UserId: user.id,
      UserName: user.name,
      UserEmail: user.email,
      Role: role,
    };

    this.loading.next(true);
    this.mixpanelService.trackAction('edit-case-role-attempt', context);
    this.mutateCaseRole(user.id, role)
      .pipe(finalize(() => this.loading.next(false)))
      .subscribe(
        () => this.mixpanelService.trackAction('edit-case-role-success', context),
        (err: ApolloError | Error) => {
          console.error(err);
          this.mixpanelService.trackAction('edit-case-role-fail', this.mixpanelService.parseGraphQlError(err, context));
          this.messageService.error(`Failed to edit case role<br>${err.message}`);
        }
      );
  }

  public hasRole(role: Roles) {
    return this.permissionService.hasRole(role, this.caseChild.id);
  }

  public setCaseRole(user: UserInfo, role: Roles | undefined) {
    if (role) {
      this.addCaseRole(user, role);
    } else {
      this.removeCaseRole(user);
    }
  }

  private removeCaseRole(user: UserInfo) {
    const context = {
      CaseId: this.caseChild.id,
      UserId: user.id,
      UserName: user.name,
      UserEmail: user.email,
    };

    this.loading.next(true);
    this.mixpanelService.trackAction('remove-case-role-attempt', context);
    this.apollo
      .mutate<caseSidebarRemoveCaseRole, caseSidebarRemoveCaseRoleVariables>({
        mutation: gql`
          mutation caseSidebarRemoveCaseRole($caseId: Int!, $userId: Int!) {
            removeCaseRole(caseId: $caseId, userId: $userId) {
              ...CaseSidebarCaseRole
            }
          }
          ${USER_INFO_FRAGMENT}
          ${CASE_SIDEBAR_CASE_ROLE_FRAGMENT}
        `,
        variables: { caseId: this.caseChild.id, userId: user.id },
        update: (cache, result) => {
          if (result.data) {
            setCaseRolesCache(this.caseChild.id, result.data.removeCaseRole, cache);
          }
        },
        refetchQueries: () => [...refetchMe(user.id, this.myUserId), 'casesContributors'],
      })
      .pipe(finalize(() => this.loading.next(false)))
      .subscribe(
        () => this.mixpanelService.trackAction('remove-case-role-success', context),
        (err: ApolloError) => {
          console.error(err);
          this.mixpanelService.trackAction('remove-case-role-fail', this.mixpanelService.parseGraphQlError(err, context));
          this.messageService.error(`Failed to remove case role<br>${err.message}`);
        }
      );
  }

  public addMemberTypeaheadSelected(user: UserInfo) {
    this.inviteForm.patchValue({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    });

    const roles = [Roles.VIEWER, user?.userTeam?.role ?? Roles.VIEWER, this.userCaseRoles.get(user.id)?.role ?? Roles.VIEWER];
    const highestRole = roles.reduce((prev, current) => (roleLevel(prev) > roleLevel(current) ? prev : current));

    this.setInviteCaseRole(highestRole);
  }

  public isInviteBusy: boolean = false;
  public inviteMember() {
    this.isInviteSubmitted = true;
    if (this.inviteForm.invalid || this.isInviteBusy) return;

    this.inviteForm.disable();
    this.isInviteBusy = true;

    const firstName = (this.firstName.value as string).trim();
    const lastName = (this.lastName.value as string).trim();
    const email = (this.email.value as string).trim().toLocaleLowerCase();
    const role = this.inviteCaseRole;

    const existingUser = this.userByEmail.get(email);
    if (existingUser?.id === this.currentUserId) {
      this.modalRef?.hide();
      return;
    }

    const context = {
      CaseId: this.caseChild.id,
      UserName: `${firstName} ${lastName}`,
      UserEmail: email,
      Role: role,
    };

    // either use existing user or invite a new user to the team
    const getUser: Observable<UserInfo> = existingUser
      ? of(existingUser)
      : this.apollo
          .mutate<caseSidebarInviteUser, caseSidebarInviteUserVariables>({
            mutation: INVITE_USER_MUTATION,
            variables: {
              caseId: this.caseChild.id,
              user: {
                firstName,
                lastName,
                emailAddress: email,
              },
            },
            update: (cache, result) => {
              if (!result.data) return;
              const users = cache.readQuery<getUsers>({ query: USERS_QUERY });
              if (!users) return;
              cache.writeQuery<getUsers>({ query: USERS_QUERY, data: { users: [...users.users, result.data.createNoPermissionUser] } });
            },
          })
          .pipe(map((result) => result.data!.createNoPermissionUser));

    this.mixpanelService.trackAction('invite-case-member-attempt', context);
    getUser
      .pipe(
        finalize(() => {
          this.inviteForm.enable();
          this.isInviteBusy = false;
        }),
        switchMap((user) => {
          const selectedLevel = roleLevel(role);
          const existingTeamLevel = existingUser?.userTeam?.role ? roleLevel(existingUser.userTeam.role) : -1;
          const existingCaseRole = this.userCaseRoles.get(existingUser?.id ?? -1);
          const existingCaseLevel = existingCaseRole ? roleLevel(existingCaseRole.role) : -1;

          if (existingTeamLevel >= selectedLevel || selectedLevel === existingCaseLevel) {
            // role already set - all done
            return of(true);
          }

          // update case role
          return this.mutateCaseRole(user.id, role);
        })
      )
      .subscribe(
        () => {
          this.mixpanelService.trackAction('invite-case-member-success', context);
          this.modalRef?.hide();
        },
        (err: ApolloError | Error) => {
          console.error(err);
          this.mixpanelService.trackAction('invite-case-member-fail', this.mixpanelService.parseGraphQlError(err, context));
          this.messageService.error(`Failed to invite case member<br>${err.message}`);
        }
      );
  }

  public isInviteSubmitted: boolean = false;
  public hasInviteError(control: AbstractControl) {
    return control.invalid && (control.dirty || control.touched || this.isInviteSubmitted);
  }

  public inviteCaseRole: Roles = Roles.VIEWER;
  public setInviteCaseRole(role: Roles | undefined) {
    this.inviteCaseRole = role ?? Roles.VIEWER;
  }

  get firstName() {
    return this.inviteForm.get('firstName') as FormControl;
  }

  get lastName() {
    return this.inviteForm.get('lastName') as FormControl;
  }

  get email() {
    return this.inviteForm.get('email') as FormControl;
  }
}
