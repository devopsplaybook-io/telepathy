<template>
  <div class="page_content_container">
    <h2>Login</h2>
    <div class="login-grid">
      <section class="login-password">
        <div class="mb-3">
          <label class="form-label">Name</label>
          <input id="username" v-model="user.name" type="text" class="form-control" />
        </div>
        <div class="mb-3">
          <label class="form-label">Password</label>
          <input
            id="password"
            ref="passwordInput"
            v-model="user.password"
            type="password"
            class="form-control"
          />
        </div>
        <button id="loginButton" v-on:click="login()" class="btn btn-primary">Login</button>
      </section>
      <LoginWithCodeCard
        :service="loginCodeService"
        :heading-level="3"
        @approved="onCodeApproved"
        @use-password="focusPassword"
      />
    </div>
  </div>
</template>

<script>
import LoginWithCodeCard from "@devopsplaybook.io/common-web/components/LoginWithCodeCard.vue";
import axios from "axios";
import { AuthService } from "~~/services/AuthService";
import { EventBus, EventTypes, handleError } from "~~/services/EventBus";
import { getLoginCodeService } from "~~/utils/loginCodes";

export default {
  name: "UserLogin",
  components: { LoginWithCodeCard },
  props: {
    msg: String,
  },
  data() {
    return {
      user: { name: "", script: "" },
      isAuthenticated: false,
      loginCodeService: getLoginCodeService(),
    };
  },
  async created() {
    await axios
      .get(`/api/users/status/initialization`)
      .then((res) => {
        if (!res.data.initialized) {
          useRouter().push({ path: "/users/new" });
        }
      })
      .catch(handleError);
    if (await AuthService.isAuthenticated()) {
      useRouter().push({ path: "/tasks" });
    }
  },
  methods: {
    async login() {
      if (this.user.name && this.user.password) {
        await axios
          .post(`/api/users/session`, this.user)
          .then((res) => {
            AuthService.saveToken(res.data.token);
            EventBus.emit(EventTypes.AUTH_UPDATED, {});
            EventBus.emit(EventTypes.ALERT_MESSAGE, {
              type: "info",
              text: "Authentication successful",
            });
            useRouter().push({ path: "/tasks" });
          })
          .catch(handleError);
      } else {
        EventBus.emit(EventTypes.ALERT_MESSAGE, {
          type: "error",
          text: "Username or password missing",
        });
      }
      this.isAuthenticated = await AuthService.isAuthenticated();
    },
    async logout() {
      await AuthService.removeToken();
      EventBus.emit(EventTypes.AUTH_UPDATED, {});
      EventBus.emit(EventTypes.ALERT_MESSAGE, {
        type: "info",
        text: "Logout successful",
      });
      this.isAuthenticated = await AuthService.isAuthenticated();
    },
    onCodeApproved() {
      // The service already persisted the redeemed session.
      useRouter().push({ path: "/tasks" });
    },
    focusPassword() {
      this.$refs.passwordInput?.focus();
    },
  },
};
</script>

<style scoped>
.login-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2rem;
  align-items: start;
}

@media (max-width: 900px) {
  .login-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>