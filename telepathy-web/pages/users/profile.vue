<template>
  <div class="page_content_container">
    <AuthorizeDeviceCard
      :service="loginCodeService"
      :heading-level="2"
      @approved="onDeviceApproved"
    />
    <button id="loginButton" v-on:click="logout()" class="btn btn-primary">Logout</button>
  </div>
</template>

<script>
import AuthorizeDeviceCard from "@devopsplaybook.io/common-web/components/AuthorizeDeviceCard.vue";
import axios from "axios";
import { AuthService } from "~~/services/AuthService";
import { EventBus, EventTypes, handleError } from "~~/services/EventBus";
import { getLoginCodeService } from "~~/utils/loginCodes";

export default {
  name: "UserLogin",
  components: { AuthorizeDeviceCard },
  props: {
    msg: String,
  },
  data() {
    return {
      loginCodeService: getLoginCodeService(),
    };
  },
  async created() {},
  methods: {
    async logout() {
      await AuthService.removeToken();
      EventBus.emit(EventTypes.AUTH_UPDATED, {});
      EventBus.emit(EventTypes.ALERT_MESSAGE, {
        type: "info",
        text: "Logout successful",
      });
      this.isAuthenticated = await AuthService.isAuthenticated();
      useRouter().push({ path: "/users/login" });
    },
    onDeviceApproved() {
      EventBus.emit(EventTypes.ALERT_MESSAGE, {
        type: "info",
        text: "Device approved",
      });
    },
  },
};
</script>

<style scoped>
button {
  margin-top: 1.5rem;
}
</style>